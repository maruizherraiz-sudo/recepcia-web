// RecepcIA — Agente IA Recepcionista para Clínicas
// Cloudflare Worker — v6: configurable por clínica + soporte multiidioma

function normalizePhone(phone) {
  const clean = String(phone).replace(/[\s\-()]/g, '');
  if (clean.startsWith('+')) return clean;
  if (clean.startsWith('0034')) return '+' + clean.slice(2);
  if (clean.length === 9) return `+34${clean}`;
  return clean;
}

// Prioriza el número real de WhatsApp guardado en la cita (cita.from) sobre
// el teléfono que el paciente escribió, que puede ser inválido o falso.
function destinoPaciente(cita) {
  if (cita.from) return cita.from.replace('whatsapp:', '');
  return normalizePhone(cita.phone);
}

// -------------------------------------------------------------------
// CONFIGURACION DE LA CLINICA
// Edita solo este bloque para adaptar el agente a cada cliente.
// El resto del codigo no hace falta tocarlo.
// -------------------------------------------------------------------
const CLINICA = {
  // Nombre con el que el agente se presenta ("la recepcionista virtual de...")
  nombre: 'nuestra clínica dental',

  // Horario de atención
  horario: 'Lunes a Viernes, 9:00 a 20:00h',

  // Lista de precios (texto libre)
  precios: `- Limpieza dental: 60€
- Blanqueamiento dental: 250€
- Ortodoncia invisible (Invisalign): desde 2.800€
- Ortodoncia con brackets: desde 1.500€
- Implante dental: desde 900€
- Empaste: 70€
- Extracción dental: 80€
- Endodoncia: desde 200€
- Consulta inicial: GRATUITA`,

  // Idioma: 'es' = solo español | 'auto' = detecta el idioma del paciente y responde en el mismo
  idioma: 'auto',

  // Enlace directo a tu ficha de Google Maps para que los pacientes dejen reseña
  // Cómo obtenerlo: busca tu clínica en Google Maps → "Escribir una reseña" → copia la URL
  googleReviewUrl: 'https://search.google.com/local/writereview?placeid=ChIJN1t_tDeuEmsRUsoyG83frY4',

  // Tratamientos de alto valor: si el paciente muestra interés, se avisa a la clínica
  tratamientosCalientes: [
    { match: /implant/i, label: 'Implantes dentales' },
    { match: /ortodon|invisalign|brackets/i, label: 'Ortodoncia' },
    { match: /blanqueamient|blanquear/i, label: 'Blanqueamiento dental' },
  ],
};
// -------------------------------------------------------------------

// Mensaje de reenganche para un lead que preguntó algo y dejó de responder sin agendar.
function buildFollowUpMessage(treatment) {
  if (treatment) {
    return `¡Hola de nuevo! 👋 Hace un par de días nos preguntabas por *${treatment}* y no queríamos dejarte sin respuesta. ¿Sigues con dudas o quieres que te ayudemos a encontrar un hueco que te venga bien? Aquí estamos para lo que necesites 😊`;
  }
  return `¡Hola! 👋 Hace un par de días estuvimos hablando y no queríamos dejarte sin respuesta. ¿Tienes alguna duda o te ayudamos a encontrar un hueco para tu cita? Estamos aquí 😊`;
}

async function twilioSend(to, body, env) {
  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: 'whatsapp:+14155238886',
        To: `whatsapp:${to}`,
        Body: body
      })
    }
  );

  // Twilio responde 200 incluso para errores de la API: hay que revisar el
  // status explícitamente o un envío rechazado (p.ej. número fuera del
  // sandbox) pasa desapercibido y el sistema lo da por entregado.
  if (!response.ok) {
    const detalle = await response.text();
    throw new Error(`Twilio rechazó el mensaje a ${to} (HTTP ${response.status}): ${detalle}`);
  }

  return response;
}

async function getBookedSlots(env) {
  const list = await env.MEMORIA.list({ prefix: 'booking:' });
  const booked = new Set();
  for (const key of list.keys) {
    booked.add(key.name.replace('booking:', ''));
  }
  return booked;
}

async function getAvailableSlots(env) {
  const booked = await getBookedSlots(env);
  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const slots = [];
  const now = new Date();
  for (let d = 1; d <= 28; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    const dayOfWeek = date.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    for (let h = 9; h < 20; h++) {
      const label = `${dayNames[dayOfWeek]} ${date.getDate()} ${monthNames[date.getMonth()]} ${String(h).padStart(2, '0')}:00`;
      if (!booked.has(label)) slots.push(label);
    }
  }
  return slots;
}

function buildCalendarLink(name, phone, slotStr, treatment) {
  const monthMap = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
  const parts = slotStr.trim().split(' ');
  const day = parseInt(parts[1]);
  const month = monthMap[parts[2]?.toLowerCase()];
  const [hours] = (parts[3] || '10:00').split(':').map(Number);
  const now = new Date();
  let year = now.getFullYear();
  const start = new Date(year, month - 1, day, hours, 0, 0);
  if (start < now) start.setFullYear(year + 1);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0];
  const title = encodeURIComponent(`${treatment}: ${name}`);
  const details = encodeURIComponent(`Teléfono: ${phone}\nAgendado por RecepcIA`);
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${fmt(start)}/${fmt(end)}&details=${details}`;
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const payload = btoa(JSON.stringify({
    iss: env.GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const signingInput = `${header}.${payload}`;
  const pemKey = env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\\r/g, '');
  const pemBody = pemKey
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');
  const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = `${signingInput}.${encodedSig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Google token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function getOrCreateCalendarId(accessToken, env) {
  // Primero buscar en KV (más fiable que el secreto estático)
  const cached = await env.MEMORIA.get('config:calendar_id');
  if (cached) {
    // Verificar que el calendario sigue existiendo
    const check = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(cached)}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (check.ok) return cached;
    // Si no existe, lo borramos del caché y creamos uno nuevo
    await env.MEMORIA.delete('config:calendar_id');
  }
  // Crear nuevo calendario
  const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary: 'Citas RecepcIA' })
  });
  if (!createRes.ok) throw new Error('No se pudo crear el calendario: ' + await createRes.text());
  const cal = await createRes.json();
  const calendarId = cal.id;
  // Guardar en KV
  await env.MEMORIA.put('config:calendar_id', calendarId);
  // Compartir con maruizherraiz@gmail.com
  await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'owner', scope: { type: 'user', value: 'maruizherraiz@gmail.com' } })
  });
  return calendarId;
}

async function createCalendarEvent(name, phone, slotStr, treatment, env) {
  try {
    const accessToken = await getGoogleAccessToken(env);
    const calendarId = await getOrCreateCalendarId(accessToken, env);
    const monthMap = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, oct:10, nov:11, dic:12 };
    const parts = slotStr.trim().split(' ');
    const day = parseInt(parts[1]);
    const month = monthMap[parts[2]?.toLowerCase()];
    const [hours, minutes] = (parts[3] || '10:00').split(':').map(Number);
    const now = new Date();
    let year = now.getFullYear();
    const start = new Date(year, month - 1, day, hours, minutes || 0);
    if (start < now) start.setFullYear(year + 1);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const event = {
      summary: `${treatment} — ${name}`,
      description: `Paciente: ${name}\nTeléfono: ${phone}\nAgendado por RecepcIA`,
      start: { dateTime: start.toISOString(), timeZone: 'Europe/Madrid' },
      end: { dateTime: end.toISOString(), timeZone: 'Europe/Madrid' },
    };
    const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
    if (!calRes.ok) console.error('Google Calendar error:', await calRes.text());
  } catch (e) {
    console.error('Error creating calendar event:', e.message);
  }
}

async function bookAppointment(name, phone, slotStr, treatment, env, fromWhatsApp = null) {
  await env.MEMORIA.put(
    `booking:${slotStr}`,
    JSON.stringify({ name, phone, slot: slotStr, treatment, bookedAt: new Date().toISOString(), from: fromWhatsApp }),
    { expirationTtl: 30 * 24 * 3600 }
  );

  const calLink = buildCalendarLink(name, phone, slotStr, treatment);

  // Notificar a la clínica (en su propio try/catch: si esto falla, que no
  // impida intentar la confirmación al paciente, que es lo prioritario)
  try {
    await twilioSend(env.ESCALADO_NUMERO,
      `📅 NUEVA CITA — RecepcIA\nPaciente: ${name}\nTeléfono: ${phone}\nTratamiento: ${treatment}\nFecha: ${slotStr}\n\n➕ Añadir al calendario:\n${calLink}`,
      env
    );
  } catch (e) {
    console.error('Error notificando nueva cita a la clínica:', e.message);
  }

  // Confirmación al paciente
  try {
    await twilioSend(normalizePhone(phone),
      `✅ ¡Cita confirmada!\n\n• *${treatment}*\n• *${slotStr}*\n\nTe recordaremos 24h antes. Si necesitas cancelar o cambiar la hora, escríbenos aquí. ¡Hasta pronto! 😊`,
      env
    );
  } catch (e) {
    console.error('Error enviando confirmación de cita al paciente:', e.message);
  }


  // Eliminar de lista de espera si estaba apuntado
  await env.MEMORIA.delete(`waitlist:${normalizePhone(phone)}`);

  // Ya ha agendado: deja de ser un "lead pendiente de seguimiento"
  if (fromWhatsApp) await env.MEMORIA.delete(`actividad:${fromWhatsApp}`);

  // Actualizar ficha del paciente con el nuevo tratamiento
  const phoneNorm = normalizePhone(phone);
  const fichaKey = `paciente:${phoneNorm}`;
  const fichaRaw = await env.MEMORIA.get(fichaKey);
  const ficha = fichaRaw ? JSON.parse(fichaRaw) : { name, phone: phoneNorm, tratamientos: [] };
  ficha.name = name;
  ficha.tratamientos.push({ tratamiento: treatment, fecha: slotStr, reservadoEl: new Date().toISOString() });
  if (ficha.tratamientos.length > 20) ficha.tratamientos = ficha.tratamientos.slice(-20);
  await env.MEMORIA.put(fichaKey, JSON.stringify(ficha), { expirationTtl: 2 * 365 * 24 * 3600 });
  // También guardar bajo el número real de WhatsApp del remitente (puede diferir del teléfono dado)
  if (fromWhatsApp) {
    const waPhone = normalizePhone(fromWhatsApp.replace('whatsapp:', ''));
    if (waPhone !== phoneNorm) {
      await env.MEMORIA.put(`paciente:${waPhone}`, JSON.stringify(ficha), { expirationTtl: 2 * 365 * 24 * 3600 });
    }
  }

  await createCalendarEvent(name, phone, slotStr, treatment, env);

  return true;
}

async function anotarListaEspera(name, phone, treatment, env) {
  const normalizedPhone = normalizePhone(phone);
  await env.MEMORIA.put(
    `waitlist:${normalizedPhone}`,
    JSON.stringify({ name, phone: normalizedPhone, treatment, createdAt: new Date().toISOString() }),
    { expirationTtl: 7 * 24 * 3600 }
  );
  await twilioSend(normalizedPhone,
    `⏳ Te hemos apuntado en lista de espera para *${treatment}*. En cuanto se libere un hueco te avisamos automáticamente. ¡Gracias por tu paciencia, ${name}!`,
    env
  );
}

// Cancela UNA cita concreta (identificada por su slot exacto), no todas las
// que tenga ese número de WhatsApp — un mismo número puede tener varias citas
// (p.ej. una persona que agenda para sí misma y para un familiar), así que
// hace falta el slot para saber cuál de ellas cancelar. Antes de borrar nada,
// comprobamos que quien pide la cancelación es realmente el dueño de esa cita.
async function cancelAppointment(fromPhone, slotStr, env) {
  const normalizedFrom = fromPhone.replace('whatsapp:', '').replace(/\s/g, '');
  const bookingKey = `booking:${slotStr}`;
  const raw = await env.MEMORIA.get(bookingKey);
  if (!raw) return [];

  const cita = JSON.parse(raw);
  const storedPhone = cita.phone.replace(/\s/g, '');
  const normalizedStored = storedPhone.startsWith('+') ? storedPhone : `+34${storedPhone}`;
  const fromMatch = cita.from && normalizedFrom === cita.from.replace('whatsapp:', '');
  if (!fromMatch && normalizedFrom !== normalizedStored && !normalizedFrom.endsWith(storedPhone)) {
    return [];
  }

  await env.MEMORIA.delete(bookingKey);
  const cancelled = [cita];

  // Notificar a la lista de espera de que se ha liberado este hueco
  const waitlist = await env.MEMORIA.list({ prefix: 'waitlist:' });
  for (const wKey of waitlist.keys) {
    const wRaw = await env.MEMORIA.get(wKey.name);
    if (!wRaw) continue;
    const entry = JSON.parse(wRaw);
    try {
      await twilioSend(entry.phone,
        `🎉 ¡Buenas noticias, ${entry.name}! Se ha liberado el hueco *${cita.slot}*. ¿Te lo reservamos? Escríbenos para confirmarlo.`,
        env
      );
    } catch (e) {
      console.error('Error notificando lista de espera:', e);
    }
  }

  return cancelled;
}

async function enviarRecordatorios(env) {
  const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const diaNum = manana.getDate();
  const mes = monthNames[manana.getMonth()];
  const diaSemana = dayNames[manana.getDay()];

  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const ayerDia = ayer.getDate();
  const ayerMes = monthNames[ayer.getMonth()];
  const ayerDiaSemana = dayNames[ayer.getDay()];

  const list = await env.MEMORIA.list({ prefix: 'booking:' });

  for (const key of list.keys) {
    const slotStr = key.name.replace('booking:', '');
    const parts = slotStr.split(' ');
    const slotDiaSemana = parts[0];
    const slotDia = parseInt(parts[1]);
    const slotMes = parts[2];

    // Recordatorio 24h para citas de mañana — pide confirmación
    if (slotDiaSemana === diaSemana && slotDia === diaNum && slotMes === mes) {
      const raw = await env.MEMORIA.get(key.name);
      if (!raw) continue;
      const cita = JSON.parse(raw);
      try {
        const pacientePhone = destinoPaciente(cita);
        await twilioSend(pacientePhone,
          `👋 Hola ${cita.name}, mañana tienes cita de *${cita.treatment}* a las *${parts[3]}h* en nuestra clínica.\n\n¿Confirmas tu asistencia?\n✅ Responde *CONFIRMO* para confirmar\n❌ Responde *CANCELO* para cancelar`,
          env
        );
        const phoneNorm = normalizePhone(pacientePhone.replace('whatsapp:', ''));
        await env.MEMORIA.put(`pendingConfirm:${phoneNorm}`, slotStr, { expirationTtl: 2 * 24 * 3600 });
      } catch (e) {
        console.error('Error enviando recordatorio:', e);
      }
    }

    // Citas de HOY sin confirmar — avisar a la clínica
    const hoy = new Date();
    const hoyDia = hoy.getDate();
    const hoyMes = monthNames[hoy.getMonth()];
    const hoyDiaSemana = dayNames[hoy.getDay()];
    if (slotDiaSemana === hoyDiaSemana && slotDia === hoyDia && slotMes === hoyMes) {
      const raw = await env.MEMORIA.get(key.name);
      if (!raw) continue;
      const cita = JSON.parse(raw);
      const phoneNorm = normalizePhone(destinoPaciente(cita).replace('whatsapp:', ''));
      const sinConfirmar = await env.MEMORIA.get(`pendingConfirm:${phoneNorm}`);
      if (sinConfirmar) {
        try {
          await twilioSend(env.ESCALADO_NUMERO,
            `⚠️ CITA SIN CONFIRMAR — RecepcIA\n\nEl paciente *${cita.name}* no ha confirmado su cita de hoy:\n• Tratamiento: ${cita.treatment}\n• Hora: ${parts[3]}h\n• Teléfono: ${cita.phone}\n\nPosible hueco libre. Puedes contactarle directamente.`,
            env
          );
        } catch (e) {
          console.error('Error avisando cita sin confirmar:', e);
        }
      }
    }

    // Encuesta post-cita para citas de ayer
    if (slotDiaSemana === ayerDiaSemana && slotDia === ayerDia && slotMes === ayerMes) {
      const surveyKey = `survey:${slotStr}`;
      const alreadySent = await env.MEMORIA.get(surveyKey);
      if (alreadySent) continue;
      const raw = await env.MEMORIA.get(key.name);
      if (!raw) continue;
      const cita = JSON.parse(raw);
      try {
        const pacientePhone = destinoPaciente(cita);
        await twilioSend(pacientePhone,
          `😊 ¡Hola ${cita.name}! Esperamos que tu cita de *${cita.treatment}* de ayer haya ido de maravilla. 🦷✨\n\n¿Cómo valorarías la atención recibida?\n\n⭐ 1 — Mejorable\n⭐⭐ 2 — Regular\n⭐⭐⭐ 3 — Bien\n⭐⭐⭐⭐ 4 — Muy bien\n⭐⭐⭐⭐⭐ 5 — Excelente\n\nResponde con un número del 1 al 5. ¡Tu opinión nos ayuda a mejorar! 🙏`,
          env
        );
        await env.MEMORIA.put(surveyKey, '1', { expirationTtl: 30 * 24 * 3600 });
        // Marcar que este paciente está esperando responder la encuesta
        const pendingKey = `pendingSurvey:${normalizePhone(pacientePhone)}`;
        await env.MEMORIA.put(pendingKey, cita.name, { expirationTtl: 7 * 24 * 3600 });
        // Guardar última visita para el recordatorio de revisión a los 6 meses
        const phoneNormVisit = normalizePhone(pacientePhone.replace('whatsapp:', ''));
        await env.MEMORIA.put(`lastVisit:${phoneNormVisit}`, JSON.stringify({
          name: cita.name, date: new Date().toISOString(), treatment: cita.treatment
        }), { expirationTtl: 400 * 24 * 3600 });
      } catch (e) {
        console.error('Error enviando encuesta:', e);
      }
    }
  }

  // Recordatorio de revisión periódica (6 meses) y reactivación (12 meses)
  const lastVisitKeys = await env.MEMORIA.list({ prefix: 'lastVisit:' });
  const SEIS_MESES_MS = 180 * 24 * 3600 * 1000;
  const DOCE_MESES_MS = 365 * 24 * 3600 * 1000;
  for (const lk of lastVisitKeys.keys) {
    const raw = await env.MEMORIA.get(lk.name);
    if (!raw) continue;
    const { name, date } = JSON.parse(raw);
    const msPasados = Date.now() - new Date(date).getTime();
    const phone = lk.name.replace('lastVisit:', '');

    // Reactivación 12 meses — tiene prioridad, solo se envía uno de los dos
    if (msPasados >= DOCE_MESES_MS) {
      const alreadySent = await env.MEMORIA.get(`reactivacionSent:${phone}`);
      if (alreadySent) continue;
      try {
        await twilioSend(phone,
          `👋 ¡Hola ${name}! Llevamos más de un año sin verte por aquí y te echamos de menos. 😊\n\nSabemos que el día a día no deja mucho tiempo, pero cuidar tu salud bucal es importante. ¿Te apetece que retomemos?\n\nEscríbeme y te busco el primer hueco disponible. ¡Estaremos encantados de verte de nuevo! 🦷✨`,
          env
        );
        await env.MEMORIA.put(`reactivacionSent:${phone}`, '1', { expirationTtl: 60 * 24 * 3600 });
      } catch (e) {
        console.error('Error enviando reactivación:', e);
      }
      continue;
    }

    // Revisión periódica 6 meses
    if (msPasados >= SEIS_MESES_MS) {
      const alreadySent = await env.MEMORIA.get(`revisionSent:${phone}`);
      if (alreadySent) continue;
      try {
        await twilioSend(phone,
          `👋 ¡Hola ${name}! Han pasado 6 meses desde tu última visita. 🦷\n\nEs el momento ideal para una revisión periódica y mantener tu salud bucal en perfecto estado.\n\n¿Quieres que te busque hueco? Escríbeme y te ayudo enseguida 😊`,
          env
        );
        await env.MEMORIA.put(`revisionSent:${phone}`, '1', { expirationTtl: 30 * 24 * 3600 });
      } catch (e) {
        console.error('Error enviando revisión periódica:', e);
      }
    }
  }
}

// Reengancha a quien escribió, mostró interés y dejó de responder sin agendar.
// `forzar` ignora la espera de 48h — solo lo usa /test-seguimiento-leads para
// poder comprobar el mensaje al momento, sin tener que esperar dos días reales.
async function seguimientoLeads(env, forzar = false) {
  const HORAS_PARA_SEGUIMIENTO = 48;
  const list = await env.MEMORIA.list({ prefix: 'actividad:' });
  const ahora = Date.now();

  for (const key of list.keys) {
    const raw = await env.MEMORIA.get(key.name);
    if (!raw) continue;
    const lead = JSON.parse(raw);
    if (lead.followUpSent) continue;

    const horasTranscurridas = (ahora - new Date(lead.lastSeen).getTime()) / 3600000;
    if (!forzar && horasTranscurridas < HORAS_PARA_SEGUIMIENTO) continue;

    const from = key.name.replace('actividad:', '');
    try {
      await twilioSend(from.replace('whatsapp:', ''), buildFollowUpMessage(lead.treatment), env);
      lead.followUpSent = true;
      await env.MEMORIA.put(key.name, JSON.stringify(lead), { expirationTtl: 7 * 24 * 3600 });
    } catch (e) {
      console.error('Error enviando seguimiento a lead:', e);
    }
  }
}

// Escapa datos antes de incrustarlos en HTML — nombre/teléfono/tratamiento
// pueden contener lo que un paciente haya escrito (vía la IA), así que sin
// esto alguien podría inyectar HTML/JS en el panel de citas.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Convierte un slot tipo "lunes 8 jun 12:00" en una fecha real, para poder
// ordenar las citas del panel cronológicamente. Los slots no incluyen el año,
// y aquí (a diferencia de buildCalendarLink, que solo mira hacia adelante)
// puede haber citas tanto pasadas como futuras — así que probamos el año
// actual, el anterior y el siguiente, y nos quedamos con el que caiga más
// cerca de "ahora". Así una cita de hace unos días no se confunde con una
// del año que viene.
function parseSlotFecha(slotStr) {
  const monthMap = { ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12 };
  const parts = String(slotStr).trim().split(' ');
  const day = parseInt(parts[1]) || 1;
  const month = (monthMap[parts[2]?.toLowerCase()] || 1) - 1;
  const [hours] = (parts[3] || '10:00').split(':').map(Number);
  const ahora = new Date();
  let mejor = null;
  for (const offset of [-1, 0, 1]) {
    const candidata = new Date(ahora.getFullYear() + offset, month, day, hours || 0, 0, 0);
    if (!mejor || Math.abs(candidata - ahora) < Math.abs(mejor - ahora)) mejor = candidata;
  }
  return mejor;
}

const PANEL_ESTILOS = `
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f6f8; color: #1f2933; margin: 0; padding: 24px; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 12px; }
  .resumen { color: #52606d; margin: 0; }
  .tabla-wrap { background: #fff; border-radius: 12px; overflow-x: auto; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  table { width: 100%; border-collapse: collapse; min-width: 520px; }
  th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid #e4e7eb; font-size: .92rem; white-space: nowrap; }
  th { background: #f4f6f8; font-weight: 600; color: #3e4c59; }
  tr:last-child td { border-bottom: none; }
  .pasada { color: #9aa5b1; }
  .vacio { padding: 24px; color: #9aa5b1; text-align: center; margin: 0; }
`;

function renderLoginPage(error) {
  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panel de citas — RecepcIA</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f6f8; color: #1f2933; margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  form { background: #fff; padding: 32px; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); width: 100%; max-width: 320px; }
  h1 { font-size: 1.2rem; margin: 0 0 20px; text-align: center; }
  input { width: 100%; padding: 12px; border: 1px solid #cbd2d9; border-radius: 8px; font-size: 1rem; margin-bottom: 12px; }
  button { width: 100%; padding: 12px; border: none; border-radius: 8px; background: #3e4c59; color: #fff; font-size: 1rem; cursor: pointer; }
  .error { color: #c0392b; font-size: .875rem; margin: 0 0 12px; text-align: center; }
</style></head><body>
  <form method="POST" action="/panel">
    <h1>🔒 Panel de citas — RecepcIA</h1>
    ${error ? '<p class="error">Contraseña incorrecta. Inténtalo de nuevo.</p>' : ''}
    <input type="password" name="clave" placeholder="Contraseña" autofocus required>
    <button type="submit">Entrar</button>
  </form>
</body></html>`;
}

function renderPanelPage(bookings, waitlist) {
  const ahora = Date.now();

  const filasCitas = bookings.map(b => {
    const pasada = parseSlotFecha(b.slot).getTime() < ahora;
    return `<tr class="${pasada ? 'pasada' : ''}">
      <td>${escapeHtml(b.slot)}${pasada ? ' (pasada)' : ''}</td>
      <td>${escapeHtml(b.name)}</td>
      <td>${escapeHtml(b.phone)}</td>
      <td>${escapeHtml(b.treatment)}</td>
    </tr>`;
  }).join('');

  const tablaCitas = bookings.length
    ? `<table><thead><tr><th>Fecha</th><th>Paciente</th><th>Teléfono</th><th>Tratamiento</th></tr></thead><tbody>${filasCitas}</tbody></table>`
    : `<p class="vacio">No hay citas agendadas todavía.</p>`;

  const filasEspera = waitlist.map(w => `<tr>
      <td>${escapeHtml(w.name)}</td>
      <td>${escapeHtml(w.phone)}</td>
      <td>${escapeHtml(w.treatment)}</td>
      <td>${new Date(w.createdAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })}</td>
    </tr>`).join('');

  const tablaEspera = waitlist.length
    ? `<table><thead><tr><th>Paciente</th><th>Teléfono</th><th>Tratamiento</th><th>Apuntado el</th></tr></thead><tbody>${filasEspera}</tbody></table>`
    : `<p class="vacio">No hay nadie en lista de espera.</p>`;

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panel de citas — RecepcIA</title>
<style>${PANEL_ESTILOS}</style></head><body>
  <div class="wrap">
    <h1>📋 Panel de citas</h1>
    <p class="resumen">${bookings.length} cita${bookings.length === 1 ? '' : 's'} agendada${bookings.length === 1 ? '' : 's'} · ${waitlist.length} en lista de espera</p>

    <h2>Citas (próximas primero)</h2>
    <div class="tabla-wrap">${tablaCitas}</div>

    <h2>Lista de espera</h2>
    <div class="tabla-wrap">${tablaEspera}</div>
  </div>
</body></html>`;
}

async function generarInformeMensual(env) {
  const ahora = new Date();
  if (ahora.getDate() !== 1) return;

  const mesAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
  const mesNombre = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][mesAnterior.getMonth()];
  const mesKey = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;

  // Contar citas y pacientes del mes anterior desde las fichas
  const pacienteKeys = await env.MEMORIA.list({ prefix: 'paciente:' });
  let totalCitas = 0;
  let nuevosPacientes = 0;
  let pacientesRecurrentes = 0;

  for (const pk of pacienteKeys.keys) {
    const raw = await env.MEMORIA.get(pk.name);
    if (!raw) continue;
    const ficha = JSON.parse(raw);
    const citasMes = ficha.tratamientos.filter(t => {
      const d = new Date(t.reservadoEl);
      return d.getFullYear() === mesAnterior.getFullYear() && d.getMonth() === mesAnterior.getMonth();
    });
    if (citasMes.length === 0) continue;
    totalCitas += citasMes.length;
    const citasAnteriores = ficha.tratamientos.length - citasMes.length;
    if (citasAnteriores === 0) nuevosPacientes++; else pacientesRecurrentes++;
  }

  // Valoración media del mes
  const statsRaw = await env.MEMORIA.get(`stats:rating:${mesKey}`);
  let ratingTxt = '⭐ Sin valoraciones este mes';
  if (statsRaw) {
    const s = JSON.parse(statsRaw);
    const avg = s.count > 0 ? (s.sum / s.count).toFixed(1) : '—';
    ratingTxt = `⭐ Valoración media: *${avg}/5* (${s.count} encuestas)`;
  }

  try {
    await twilioSend(env.ESCALADO_NUMERO,
      `📊 *INFORME MENSUAL RecepcIA — ${mesNombre} ${mesAnterior.getFullYear()}*\n\n📅 Citas gestionadas: *${totalCitas}*\n🆕 Nuevos pacientes: *${nuevosPacientes}*\n🔄 Pacientes recurrentes: *${pacientesRecurrentes}*\n${ratingTxt}\n\n_Generado automáticamente por RecepcIA_ 🤖`,
      env
    );
  } catch (e) {
    console.error('Error enviando informe mensual:', e);
  }
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(enviarRecordatorios(env));
    ctx.waitUntil(seguimientoLeads(env));
    ctx.waitUntil(generarInformeMensual(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method === 'GET') {
      if (url.pathname === '/test-calendar') {
        try {
          const accessToken = await getGoogleAccessToken(env);

          // Crear un calendario nuevo propio de la cuenta de servicio
          const createRes = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary: 'Citas RecepcIA' })
          });
          const createBody = await createRes.json();

          if (!createRes.ok) {
            return new Response(`❌ No se pudo crear el calendario\nHTTP ${createRes.status}\n${JSON.stringify(createBody, null, 2)}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
          }

          const newCalendarId = createBody.id;

          // Compartir el calendario con el email del dueño
          const aclRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(newCalendarId)}/acl`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'owner', scope: { type: 'user', value: 'maruizherraiz@gmail.com' } })
          });
          const aclBody = await aclRes.text();

          // Crear evento de prueba
          const start = new Date(Date.now() + 3600000);
          const end = new Date(Date.now() + 7200000);
          const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(newCalendarId)}/events`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ summary: 'TEST RecepcIA', start: { dateTime: start.toISOString(), timeZone: 'Europe/Madrid' }, end: { dateTime: end.toISOString(), timeZone: 'Europe/Madrid' } })
          });
          const eventBody = await calRes.text();

          return new Response(`✅ Calendario creado\nNUEVO CALENDAR ID: ${newCalendarId}\n\nCompartir con maruizherraiz@gmail.com: HTTP ${aclRes.status}\n${aclBody}\n\nEvento de prueba: HTTP ${calRes.status}\n${eventBody}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {
          return new Response(`❌ Error: ${e.message}\n\n${e.stack}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
        }
      }
      if (url.pathname === '/test-crear-cita') {
        try {
          const accessToken = await getGoogleAccessToken(env);
          const calendarId = await getOrCreateCalendarId(accessToken, env);
          const tomorrow = new Date(Date.now() + 86400000);
          const day = tomorrow.getDate();
          const monthNames = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
          const month = monthNames[tomorrow.getMonth()];
          const start = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), day, 10, 0);
          const end = new Date(start.getTime() + 60 * 60 * 1000);
          const event = {
            summary: `TEST Diagnóstico — Mángel`,
            description: `Prueba de integración Google Calendar`,
            start: { dateTime: start.toISOString(), timeZone: 'Europe/Madrid' },
            end: { dateTime: end.toISOString(), timeZone: 'Europe/Madrid' },
          };
          const calRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          });
          const body = await calRes.text();
          return new Response(`Calendar ID usado: ${calendarId}\nHTTP ${calRes.status}\n\n${body}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {
          return new Response(`❌ Error: ${e.message}\n\n${e.stack}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
        }
      }
      if (url.pathname === '/fix-calendar-sharing') {
        try {
          const accessToken = await getGoogleAccessToken(env);
          const calendarId = env.GOOGLE_CALENDAR_ID;
          const aclRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/acl`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'owner', scope: { type: 'user', value: 'mangel237118@gmail.com' } })
          });
          const aclBody = await aclRes.text();
          return new Response(`HTTP ${aclRes.status}\n${aclBody}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
        } catch (e) {
          return new Response(`❌ Error: ${e.message}`, { status: 500, headers: { 'Content-Type': 'text/plain' } });
        }
      }
      if (url.pathname === '/test-revision') {
        const phone = url.searchParams.get('phone') || '652729273';
        const meses = parseInt(url.searchParams.get('meses') || '7');
        const normalized = normalizePhone(phone);
        const fechaAntigua = new Date(Date.now() - meses * 30 * 24 * 3600 * 1000).toISOString();
        await env.MEMORIA.put(`lastVisit:${normalized}`, JSON.stringify({
          name: 'Mángel', date: fechaAntigua, treatment: 'Limpieza dental'
        }), { expirationTtl: 400 * 24 * 3600 });
        await env.MEMORIA.delete(`revisionSent:${normalized}`);
        await env.MEMORIA.delete(`reactivacionSent:${normalized}`);
        return new Response(`✅ lastVisit creada para ${normalized}\nFecha simulada: hace ${meses} meses (${fechaAntigua})\nAhora abre /test-cron para disparar el recordatorio.`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }

      if (url.pathname === '/test-survey') {
        const phone = url.searchParams.get('phone') || '652729273';
        const normalized = normalizePhone(phone);
        await env.MEMORIA.put(`pendingSurvey:${normalized}`, 'Mángel', { expirationTtl: 3600 });
        return new Response(`✅ Encuesta pendiente creada para ${normalized}\nAhora manda un WhatsApp con "4" o "5" al número de RecepcIA.`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }

      if (url.pathname === '/test-confirm') {
        const phone = url.searchParams.get('phone') || '652729273';
        const slot = url.searchParams.get('slot') || 'lun 16 jun 10:00';
        const normalized = normalizePhone(phone);
        await env.MEMORIA.put(`pendingConfirm:${normalized}`, slot, { expirationTtl: 3600 });
        return new Response(`✅ Confirmación pendiente creada para ${normalized}\nSlot: ${slot}\nAhora manda CONFIRMO o CANCELO al número de RecepcIA.`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
      }
      if (url.pathname === '/test-cron') {
        try {
          await enviarRecordatorios(env);
          return new Response('✅ enviarRecordatorios ejecutado. Revisa WhatsApp.', { status: 200 });
        } catch (e) {
          return new Response(`❌ Error: ${e.message}`, { status: 500 });
        }
      }
      if (url.pathname === '/test-seguimiento-leads') {
        try {
          const forzar = url.searchParams.get('forzar') === '1';
          await seguimientoLeads(env, forzar);
          return new Response(`✅ seguimientoLeads ejecutado${forzar ? ' (modo forzado: ignora la espera de 48h)' : ''}. Revisa WhatsApp.`, { status: 200 });
        } catch (e) {
          return new Response(`❌ Error: ${e.message}`, { status: 500 });
        }
      }
      if (url.pathname === '/test-informe') {
        try {
          // Forzar envío ignorando el check del día 1
          const ahora = new Date();
          const mesAnterior = new Date(ahora.getFullYear(), ahora.getMonth() - 1, 1);
          const mesNombre = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'][mesAnterior.getMonth()];
          const mesKey = `${mesAnterior.getFullYear()}-${String(mesAnterior.getMonth() + 1).padStart(2, '0')}`;
          const pacienteKeys = await env.MEMORIA.list({ prefix: 'paciente:' });
          let totalCitas = 0, nuevosPacientes = 0, pacientesRecurrentes = 0;
          for (const pk of pacienteKeys.keys) {
            const raw = await env.MEMORIA.get(pk.name);
            if (!raw) continue;
            const ficha = JSON.parse(raw);
            const citasMes = ficha.tratamientos.filter(t => {
              const d = new Date(t.reservadoEl);
              return d.getFullYear() === mesAnterior.getFullYear() && d.getMonth() === mesAnterior.getMonth();
            });
            if (citasMes.length === 0) continue;
            totalCitas += citasMes.length;
            if (ficha.tratamientos.length - citasMes.length === 0) nuevosPacientes++; else pacientesRecurrentes++;
          }
          const statsRaw = await env.MEMORIA.get(`stats:rating:${mesKey}`);
          let ratingTxt = '⭐ Sin valoraciones este mes';
          if (statsRaw) {
            const s = JSON.parse(statsRaw);
            ratingTxt = `⭐ Valoración media: *${(s.sum/s.count).toFixed(1)}/5* (${s.count} encuestas)`;
          }
          await twilioSend(env.ESCALADO_NUMERO,
            `📊 *INFORME MENSUAL RecepcIA — ${mesNombre} ${mesAnterior.getFullYear()}*\n\n📅 Citas gestionadas: *${totalCitas}*\n🆕 Nuevos pacientes: *${nuevosPacientes}*\n🔄 Pacientes recurrentes: *${pacientesRecurrentes}*\n${ratingTxt}\n\n_Generado automáticamente por RecepcIA_ 🤖`,
            env
          );
          return new Response('✅ Informe mensual enviado. Revisa WhatsApp.', { status: 200 });
        } catch (e) {
          return new Response(`❌ Error: ${e.message}`, { status: 500 });
        }
      }
      if (url.pathname === '/panel') {
        return new Response(renderLoginPage(false), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
      }
      if (url.pathname === '/vapi/slots') {
        try {
          const slots = await getAvailableSlots(env);
          const msg = slots.length > 0
            ? `Huecos disponibles: ${slots.join(', ')}`
            : 'No hay huecos disponibles esta semana. Consulta directamente con la clinica.';
          return new Response(JSON.stringify({ slots, message: msg }), {
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
      }
      return new Response('RecepcIA Agent activo ✓', { status: 200 });
    }

    // Panel de citas: página privada protegida con contraseña (env.PANEL_PASSWORD).
    // Va aparte del flujo de WhatsApp de abajo, que asume que todo POST es un mensaje entrante.
    if (request.method === 'POST' && url.pathname === '/panel') {
      try {
        const formData = await request.formData();
        const clave = formData.get('clave') || '';
        if (!env.PANEL_PASSWORD || clave !== env.PANEL_PASSWORD) {
          return new Response(renderLoginPage(true), { status: 401, headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
        }

        const bookingsList = await env.MEMORIA.list({ prefix: 'booking:' });
        const bookings = [];
        for (const key of bookingsList.keys) {
          const raw = await env.MEMORIA.get(key.name);
          if (raw) bookings.push(JSON.parse(raw));
        }
        // Próximas primero (de la más cercana a la más lejana) y, después,
        // las pasadas (de la más reciente a la más antigua) — así lo primero
        // que se ve es lo que de verdad importa: lo que está por venir.
        const ahoraMs = Date.now();
        bookings.sort((a, b) => {
          const fa = parseSlotFecha(a.slot).getTime();
          const fb = parseSlotFecha(b.slot).getTime();
          const futuraA = fa >= ahoraMs;
          const futuraB = fb >= ahoraMs;
          if (futuraA !== futuraB) return futuraA ? -1 : 1;
          return futuraA ? fa - fb : fb - fa;
        });

        const waitlistList = await env.MEMORIA.list({ prefix: 'waitlist:' });
        const waitlist = [];
        for (const key of waitlistList.keys) {
          const raw = await env.MEMORIA.get(key.name);
          if (raw) waitlist.push(JSON.parse(raw));
        }
        waitlist.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        return new Response(renderPanelPage(bookings, waitlist), { headers: { 'Content-Type': 'text/html; charset=UTF-8' } });
      } catch (e) {
        console.error('Error generando panel de citas:', e);
        return new Response('❌ Error generando el panel.', { status: 500 });
      }
    }

    // ── WIDGET CHAT ENDPOINT ──────────────────────────────────────────
    // Acepta mensajes desde el widget web embebido en cualquier clínica.
    if (request.method === 'POST' && url.pathname === '/chat') {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
      };
      try {
        const body = await request.json();
        const userMessage = body.message || '';
        const sessionId = body.sessionId || 'widget_anon';
        if (!userMessage) {
          return new Response(JSON.stringify({ reply: 'Escribe tu mensaje.' }), { headers: corsHeaders });
        }

        const histKey = `widget:${sessionId}`;
        const historialRaw = await env.MEMORIA.get(histKey);
        let historial = historialRaw ? JSON.parse(historialRaw) : [];
        historial.push({ role: 'user', content: userMessage });
        if (historial.length > 20) historial = historial.slice(historial.length - 20);

        let slotsText = 'No hay huecos disponibles esta semana. Consulta directamente.';
        try {
          const slots = await getAvailableSlots(env);
          if (slots.length > 0) slotsText = `Huecos disponibles: ${slots.join(' | ')}`;
        } catch (e) {}

        const idiomaInstruccion = CLINICA.idioma === 'auto'
          ? 'Detecta el idioma que usa el paciente y responde SIEMPRE en ese mismo idioma.'
          : 'Responde siempre en español.';

        const systemPrompt = `Eres RecepcIA, la recepcionista virtual de ${CLINICA.nombre}. Eres amable, profesional y eficiente.
HORARIO: ${CLINICA.horario}.
PRECIOS:
${CLINICA.precios}
${slotsText}
INSTRUCCIONES:
1. Sé cordial y empática. Da precios directamente sin rodeos.
2. Si el paciente quiere una cita, anímale a llamar o continuar por WhatsApp para confirmarla.
3. ${idiomaInstruccion} Máximo 3-4 frases por mensaje.`;

        const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            system: systemPrompt,
            messages: historial,
          }),
        });

        const claudeData = await claudeResponse.json();
        let reply = claudeData.content[0].text;
        reply = reply
          .replace(/\[AGENDAR:[^\]]+\]/g, '')
          .replace(/\[CANCELAR:[^\]]+\]/g, '')
          .replace(/\[LEAD_CALIENTE:[^\]]+\]/g, '')
          .replace(/\[ESCALADO_HUMANO\]/g, '')
          .replace(/\[LISTA_ESPERA:[^\]]+\]/g, '')
          .trim();

        historial.push({ role: 'assistant', content: reply });
        if (historial.length > 20) historial = historial.slice(historial.length - 20);
        await env.MEMORIA.put(histKey, JSON.stringify(historial), { expirationTtl: 3600 });

        return new Response(JSON.stringify({ reply }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ reply: 'Lo siento, ha ocurrido un error. Inténtalo de nuevo.' }), {
          headers: corsHeaders, status: 500,
        });
      }
    }
    // ── VAPI GET SLOTS ───────────────────────────────────────────────
    if (url.pathname === '/vapi/slots') {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
      };
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
      try {
        const slots = await getAvailableSlots(env);
        const msg = slots.length > 0
          ? `Huecos disponibles: ${slots.join(', ')}`
          : 'No hay huecos disponibles esta semana. Consulta directamente con la clinica.';
        return new Response(JSON.stringify({ slots, message: msg }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    // ── VAPI BOOK APPOINTMENT ─────────────────────────────────────────
    if (url.pathname === '/vapi/book') {
      const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json',
      };
      if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
      try {
        const body = await request.json();
        let name, phone, treatment, slot, toolCallId;

        if (body.message && body.message.toolCallList) {
          const tc = body.message.toolCallList[0];
          toolCallId = tc.id;
          const args = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
          name = args.name; phone = args.phone;
          treatment = args.treatment || 'Consulta general'; slot = args.slot;
        } else {
          name = body.name; phone = body.phone;
          treatment = body.treatment || 'Consulta general'; slot = body.slot;
        }

        if (!name || !phone || !slot) {
          const err = { error: 'Faltan datos: name, phone y slot son obligatorios.' };
          if (toolCallId) return new Response(JSON.stringify({ results: [{ toolCallId, result: err.error }] }), { headers: corsHeaders });
          return new Response(JSON.stringify(err), { status: 400, headers: corsHeaders });
        }

        await bookAppointment(name, phone, slot, treatment, env);
        const msg = `Cita registrada correctamente para ${name} el ${slot}. El equipo enviará confirmación.`;
        if (toolCallId) return new Response(JSON.stringify({ results: [{ toolCallId, result: msg }] }), { headers: corsHeaders });
        return new Response(JSON.stringify({ success: true, message: msg }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }
    // ─────────────────────────────────────────────────────────────────

    try {
      const contentType = request.headers.get('content-type') || '';
      let userMessage = '', from = '';

      if (contentType.includes('application/x-www-form-urlencoded')) {
        const formData = await request.formData();
        userMessage = formData.get('Body') || '';
        from = formData.get('From') || '';
      } else {
        const body = await request.json();
        userMessage = body.message || '';
        from = body.from || 'test';
      }

      if (!userMessage) {
        return new Response('<?xml version="1.0"?><Response></Response>', {
          headers: { 'Content-Type': 'text/xml' }
        });
      }

      const fromNorm = normalizePhone(from.replace('whatsapp:', ''));

      // Interceptar CONFIRMO / CANCELO de cita
      const confirmMsg = userMessage.trim().toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      const pendingConfirmSlot = await env.MEMORIA.get(`pendingConfirm:${fromNorm}`);
      if (pendingConfirmSlot && (confirmMsg === 'CONFIRMO' || confirmMsg === 'CANCELO')) {
        await env.MEMORIA.delete(`pendingConfirm:${fromNorm}`);
        if (confirmMsg === 'CONFIRMO') {
          await twilioSend(fromNorm, `✅ ¡Perfecto! Tu cita está confirmada. ¡Te esperamos mañana!`, env);
        } else {
          // Cancelar la cita del KV
          const allKeys = await env.MEMORIA.list({ prefix: 'booking:' });
          for (const k of allKeys.keys) {
            const raw = await env.MEMORIA.get(k.name);
            if (!raw) continue;
            const cita = JSON.parse(raw);
            const citaPhone = normalizePhone(destinoPaciente(cita).replace('whatsapp:', ''));
            if (citaPhone === fromNorm && k.name.includes(pendingConfirmSlot.replace(/\s/g, '_'))) {
              await env.MEMORIA.delete(k.name);
              break;
            }
          }
          await twilioSend(fromNorm, `Entendido, hemos cancelado tu cita. Si quieres volver a reservar, escríbenos cuando quieras. 😊`, env);
          await twilioSend(env.ESCALADO_NUMERO,
            `⚠️ CITA CANCELADA POR EL PACIENTE\nTeléfono: ${fromNorm}\nSlot: ${pendingConfirmSlot}`,
            env
          );
        }
        return new Response('<?xml version="1.0"?><Response></Response>', { headers: { 'Content-Type': 'text/xml' } });
      }

      // Interceptar respuesta a encuesta post-cita (1-5)
      const surveyRating = userMessage.trim();
      const pendingSurveyKey = `pendingSurvey:${fromNorm}`;
      const pendingSurveyName = await env.MEMORIA.get(pendingSurveyKey);
      if (pendingSurveyName && /^[1-5]$/.test(surveyRating)) {
        await env.MEMORIA.delete(pendingSurveyKey);
        const rating = parseInt(surveyRating);
        let replyMsg;
        if (rating >= 4) {
          replyMsg = `¡Muchas gracias por tu valoración de ${surveyRating} estrellas, ${pendingSurveyName}! 🌟 Nos alegra mucho que hayas quedado satisfecho/a.\n\n¿Nos ayudarías dejando una reseña en Google? Solo toma un minuto y nos ayuda muchísimo 🙏\n\n👉 ${CLINICA.googleReviewUrl}`;
        } else {
          replyMsg = `Gracias por tu honestidad, ${pendingSurveyName}. Sentimos que tu experiencia no haya sido perfecta. Si quieres contarnos qué podemos mejorar, estamos aquí para escucharte. 🙏`;
        }
        // Acumular valoración en stats mensuales
        const now = new Date();
        const statsKey = `stats:rating:${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const statsRaw = await env.MEMORIA.get(statsKey);
        const stats = statsRaw ? JSON.parse(statsRaw) : { sum: 0, count: 0 };
        stats.sum += rating;
        stats.count += 1;
        await env.MEMORIA.put(statsKey, JSON.stringify(stats), { expirationTtl: 400 * 24 * 3600 });

        await twilioSend(fromNorm, replyMsg, env);
        return new Response('<?xml version="1.0"?><Response></Response>', { headers: { 'Content-Type': 'text/xml' } });
      }

      const historialRaw = await env.MEMORIA.get(from);
      let historial = historialRaw ? JSON.parse(historialRaw) : [];
      historial.push({ role: 'user', content: userMessage });
      if (historial.length > 20) historial = historial.slice(historial.length - 20);

      let slotsText = 'No hay huecos disponibles esta semana. Consulta directamente.';
      try {
        const slots = await getAvailableSlots(env);
        if (slots.length > 0) {
          slotsText = `Huecos disponibles: ${slots.join(' | ')}`;
        }
      } catch (e) {
        slotsText = 'No se pudo consultar la agenda en este momento.';
      }

      // Ficha del paciente
      const fichaRaw = await env.MEMORIA.get(`paciente:${fromNorm}`);
      const fichaText = fichaRaw
        ? (() => {
            const f = JSON.parse(fichaRaw);
            const lista = f.tratamientos.map(t => `${t.tratamiento} (${t.fecha})`).join(', ');
            return `HISTORIAL DEL PACIENTE: ${f.name} ya ha tenido estas citas anteriores: ${lista}. Puedes usar esta información para personalizar la atención.`;
          })()
        : '';

      const idiomaInstruccion = CLINICA.idioma === 'auto'
        ? 'Detecta el idioma que usa el paciente y responde SIEMPRE en ese mismo idioma (español, inglés, catalán, francés…). No cambies de idioma a lo largo de la conversación.'
        : 'Responde siempre en español.';

      const ahora = new Date();
      const diasSemana = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
      const meses = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
      const fechaHoy = `${diasSemana[ahora.getDay()]} ${ahora.getDate()} ${meses[ahora.getMonth()]}`;
      const fechaMañana = new Date(ahora.getTime() + 86400000);
      const fechaMañanaStr = `${diasSemana[fechaMañana.getDay()]} ${fechaMañana.getDate()} ${meses[fechaMañana.getMonth()]}`;

      const systemPrompt = `Eres RecepcIA, la recepcionista virtual de ${CLINICA.nombre}. Eres amable, profesional y eficiente.

FECHA ACTUAL: hoy es ${fechaHoy}. Mañana es ${fechaMañanaStr}. Usa esto para interpretar correctamente peticiones como "mañana", "esta semana", "pasado mañana", etc. Si hay huecos disponibles para la fecha que pide el paciente, ofrécelos directamente sin decir que no hay disponibilidad.

${fichaText}

HORARIO DE LA CLÍNICA: ${CLINICA.horario}.

PRECIOS:
${CLINICA.precios}

${slotsText}

INSTRUCCIONES IMPORTANTES:
1. Sé siempre cordial y empática. Llama al paciente por su nombre si ya lo conoces.
2. Si preguntan por precios, dáselos directamente sin rodeos.
3. Para agendar una cita necesitas CUATRO datos obligatorios: nombre completo, teléfono de contacto, el hueco horario elegido y el tipo de tratamiento que desea (limpieza, revisión, ortodoncia, implante, etc.). Pregunta siempre el tratamiento ANTES de confirmar la cita. Nunca reserves sin saber qué tratamiento quiere el paciente.
4. Cuando ofrezcas huecos, muéstralos con su formato COMPLETO exactamente como aparecen en la lista (ej: "lunes 8 jun 10:00", "lunes 8 jun 11:00"). No los reformatees ni abrevies.
5. ⚠️ REGLA CRÍTICA: En cuanto el paciente confirme nombre + teléfono + horario, DEBES añadir al final de tu respuesta esta línea exacta:
   [AGENDAR:nombre_completo|telefono|slot_exacto|tratamiento]
   Ejemplo: [AGENDAR:Marta García|657589073|lunes 8 jun 12:00|Limpieza dental]
   SIN este tag la cita NO se registra en el sistema. Es OBLIGATORIO siempre.
6. Si detectas una urgencia médica, dolor intenso, accidente o el paciente está muy angustiado, añade al FINAL: [ESCALADO_HUMANO]
7. NUNCA inventes huecos que no estén en la lista. Solo ofrece los disponibles.
8. ${idiomaInstruccion} Máximo 3-4 frases por mensaje.
9. Si el paciente quiere cancelar su cita, primero confirma con él la fecha y hora EXACTAS de esa cita (un mismo número puede tener más de una cita agendada, así que nunca canceles "a ciegas"). Una vez confirmada, añade al FINAL de tu respuesta esta línea exacta, usando el mismo formato de fecha que en los huecos disponibles:
   [CANCELAR:slot_exacto]
   Ejemplo: [CANCELAR:martes 9 jun 18:00]
   Tras confirmar la cancelación, ofrécele reagendar con los huecos disponibles.
10. Si no hay huecos disponibles y el paciente quiere que le avisemos, añade al FINAL: [LISTA_ESPERA:nombre_completo|telefono|tratamiento]
11. Si el paciente muestra interés real en los tratamientos de alto valor de esta clínica —pregunta el precio, pide más información o se lo está planteando— añade al FINAL: [LEAD_CALIENTE:nombre_del_tratamiento]
   Ejemplo: [LEAD_CALIENTE:Ortodoncia]`;

      const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1024,
          system: systemPrompt,
          messages: historial
        })
      });

      const claudeData = await claudeResponse.json();
      let agentReply = claudeData.content[0].text;

      // Detectar [AGENDAR]
      let citaAgendadaAhora = false;
      const agendarMatch = agentReply.match(/\[AGENDAR:([^|]+)\|([^|]+)\|([^|]+)\|([^\]]+)\]/);
      if (agendarMatch) {
        const [, name, phone, slotStr, treatment] = agendarMatch;
        try {
          await bookAppointment(name.trim(), phone.trim(), slotStr.trim(), treatment.trim(), env, from);
          citaAgendadaAhora = true;
        } catch (e) {
          console.error('Error en bookAppointment:', e.message);
        }
        agentReply = agentReply.replace(/\[AGENDAR:[^\]]+\]/, '').trim();
      }

      // Detectar [LISTA_ESPERA]
      const listaEsperaMatch = agentReply.match(/\[LISTA_ESPERA:([^|]+)\|([^|]+)\|([^\]]+)\]/);
      if (listaEsperaMatch) {
        const [, name, phone, treatment] = listaEsperaMatch;
        agentReply = agentReply.replace(/\[LISTA_ESPERA:[^\]]+\]/, '').trim();
        try {
          await anotarListaEspera(name.trim(), phone.trim(), treatment.trim(), env);
        } catch (e) {
          console.error('Error anotando lista de espera:', e);
        }
      }

      // Detectar [CANCELAR:slot_exacto]
      const cancelarMatch = agentReply.match(/\[CANCELAR:([^\]]+)\]/);
      if (cancelarMatch) {
        const slotACancelar = cancelarMatch[1].trim();
        agentReply = agentReply.replace(/\[CANCELAR:[^\]]+\]/, '').trim();
        try {
          const cancelled = await cancelAppointment(from, slotACancelar, env);
          if (cancelled.length > 0) {
            for (const cita of cancelled) {
              try {
                await twilioSend(env.ESCALADO_NUMERO,
                  `❌ CITA CANCELADA — RecepcIA\nPaciente: ${cita.name}\nTeléfono: ${cita.phone}\nTratamiento: ${cita.treatment}\nFecha cancelada: ${cita.slot}`,
                  env
                );
              } catch (e) {
                console.error('Error notificando cancelación a la clínica:', e.message);
              }
            }
          }
        } catch (e) {
          console.error('Error cancelando cita:', e);
        }
      }

      // Detectar [ESCALADO_HUMANO]
      if (agentReply.includes('[ESCALADO_HUMANO]')) {
        agentReply = agentReply.replace('[ESCALADO_HUMANO]', '').trim();
        try {
          await twilioSend(env.ESCALADO_NUMERO,
            `🚨 URGENCIA — Paciente ${from} necesita atención inmediata.\nÚltimo mensaje: "${userMessage}"`,
            env
          );
        } catch (e) {
          console.error('Error al enviar escalado:', e);
        }
      }

      // Detectar [LEAD_CALIENTE] — interés en tratamiento de alto valor
      let tratamientoInteres = null;
      const leadMatch = agentReply.match(/\[LEAD_CALIENTE:([^\]]+)\]/);
      if (leadMatch) {
        tratamientoInteres = leadMatch[1].trim();
        agentReply = agentReply.replace(/\[LEAD_CALIENTE:[^\]]+\]/, '').trim();
      } else {
        const detectado = CLINICA.tratamientosCalientes.find(t => t.match.test(userMessage));
        if (detectado) tratamientoInteres = detectado.label;
      }
      if (tratamientoInteres) {
        const leadKey = `lead:${from}:${tratamientoInteres}`;
        const yaAvisado = await env.MEMORIA.get(leadKey);
        if (!yaAvisado) {
          try {
            await twilioSend(env.ESCALADO_NUMERO,
              `🔥 LEAD CALIENTE — RecepcIA\nUn paciente muestra interés en *${tratamientoInteres}*.\nWhatsApp: ${from.replace('whatsapp:', '')}\nMensaje: "${userMessage}"\n\n📞 Contacta cuanto antes para cerrar la cita.`,
              env
            );
            await env.MEMORIA.put(leadKey, '1', { expirationTtl: 24 * 3600 });
          } catch (e) {
            console.error('Error enviando aviso de lead caliente:', e);
          }
        }
      }

      // Registramos la última vez que escribió alguien que aún no ha agendado,
      // para poder reengancharlo a las 48h si deja de responder (seguimientoLeads).
      if (!citaAgendadaAhora) {
        try {
          const actividadKey = `actividad:${from}`;
          const actividadRaw = await env.MEMORIA.get(actividadKey);
          const actividadPrevia = actividadRaw ? JSON.parse(actividadRaw) : null;
          await env.MEMORIA.put(actividadKey, JSON.stringify({
            lastSeen: new Date().toISOString(),
            treatment: tratamientoInteres || actividadPrevia?.treatment || null,
            followUpSent: false
          }), { expirationTtl: 7 * 24 * 3600 });
        } catch (e) {
          console.error('Error registrando actividad de lead:', e);
        }
      }

      historial.push({ role: 'assistant', content: agentReply });
      await env.MEMORIA.put(from, JSON.stringify(historial), { expirationTtl: 86400 });

      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${agentReply}</Message></Response>`,
        { headers: { 'Content-Type': 'text/xml' } }
      );

    } catch (error) {
      console.error('Error general:', error);
      return new Response(
        `<?xml version="1.0" encoding="UTF-8"?><Response><Message>Lo siento, ha habido un error técnico. Por favor, inténtalo de nuevo o llámanos directamente.</Message></Response>`,
        { headers: { 'Content-Type': 'text/xml' } }
      );
    }
  }
};
