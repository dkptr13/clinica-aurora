'use strict';

/* ============================================================================
 * Clínica Dental Aurora — Cloud Functions
 * ----------------------------------------------------------------------------
 * Toda escritura sensible se valida aquí. Las reglas de Firestore impiden que
 * el navegador cree citas, modifique roles o fabrique resúmenes clínicos.
 *
 * Región: europe-west9 (París), la misma que la base Firestore del proyecto
 * clinicadental-aurora, verificada el 2026-11-25. Se puede sobreescribir con
 * FUNCTIONS_REGION, pero no cambiar la región de Firestore/Storage sin revisar
 * antes la ubicación real y los requisitos RGPD/LOPDGDD.
 * ========================================================================== */

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const logger = require('firebase-functions/logger');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { GoogleAuth } = require('google-auth-library');

admin.initializeApp();
const db = admin.firestore();
const { FieldValue, Timestamp } = require('firebase-admin/firestore');

const REGION = process.env.FUNCTIONS_REGION || 'europe-west9';
setGlobalOptions({ region: REGION, maxInstances: 20 });

const ROLES = ['patient', 'admin', 'reception', 'dentist'];
const APPT_STATUS = ['pending', 'confirmed', 'cancelled', 'done'];
const PAY_STATUS = ['pending', 'paid', 'refunded', 'void'];
const HOLD_MS = 24 * 60 * 60 * 1000;

const DEFAULT_SLOTS = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00'
];

const DEFAULT_TREATMENTS = [
  { id: 'limpieza', n: 'Limpieza dental', min: 45, p: 60, dentistIds: ['d1', 'd2', 'd3'], active: true },
  { id: 'ortodoncia', n: 'Ortodoncia', min: 30, p: 90, dentistIds: ['d2'], active: true },
  { id: 'implantes', n: 'Implantes', min: 60, p: 950, dentistIds: ['d1'], active: true },
  { id: 'blanqueamiento', n: 'Blanqueamiento', min: 60, p: 240, dentistIds: ['d1', 'd3'], active: true },
  { id: 'endodoncia', n: 'Endodoncia', min: 60, p: 180, dentistIds: ['d3'], active: true },
  { id: 'revision', n: 'Revisión', min: 30, p: 35, dentistIds: ['d1', 'd2', 'd3'], active: true }
];

const DEFAULT_DENTISTS = [
  { id: 'd1', n: 'Dra. Laura Méndez', r: 'Odontología general e implantes', active: true },
  { id: 'd2', n: 'Dr. Pablo Serrano', r: 'Ortodoncia', active: true },
  { id: 'd3', n: 'Dra. Marta Vidal', r: 'Endodoncia y estética dental', active: true }
];

/* ------------------------------------------------------------------ helpers */

function appCheckGate(request) {
  if (process.env.ENFORCE_APP_CHECK === 'true' && !request.app) {
    throw new HttpsError('failed-precondition', 'App Check es obligatorio para esta operación.');
  }
}

function requireAuth(request, roles) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Inicia sesión de nuevo.');
  const role = request.auth.token && request.auth.token.role;
  if (roles && roles.length && !roles.includes(role)) {
    throw new HttpsError('permission-denied', 'No tienes permiso para esta operación.');
  }
  return { uid: request.auth.uid, role, token: request.auth.token };
}

function clean(value, max, { min = 0, label = 'campo' } = {}) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (v.length < min) throw new HttpsError('invalid-argument', 'Falta ' + label + '.');
  if (v.length > max) throw new HttpsError('invalid-argument', label + ' es demasiado largo.');
  return v;
}

function cleanMultiline(value, max, { min = 0, label = 'campo' } = {}) {
  const v = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
  if (v.length < min) throw new HttpsError('invalid-argument', 'Falta ' + label + '.');
  if (v.length > max) throw new HttpsError('invalid-argument', label + ' es demasiado largo.');
  return v;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function email(value) {
  const v = clean(value, 254, { label: 'correo' }).toLowerCase();
  if (!EMAIL_RE.test(v)) throw new HttpsError('invalid-argument', 'El correo no tiene un formato válido.');
  return v;
}

function phone(value, required = false) {
  const v = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!v && !required) return '';
  if (!/^[+()\d\s.-]{9,30}$/.test(v)) {
    throw new HttpsError('invalid-argument', 'El teléfono no tiene un formato válido.');
  }
  return v;
}

function assertDate(date) {
  if (!DATE_RE.test(String(date || ''))) throw new HttpsError('invalid-argument', 'Fecha no válida.');
  return date;
}

function assertTime(time) {
  if (!TIME_RE.test(String(time || ''))) throw new HttpsError('invalid-argument', 'Hora no válida.');
  return time;
}

function assertRole(role) {
  if (!ROLES.includes(role)) throw new HttpsError('invalid-argument', 'Rol no válido.');
  return role;
}

function t2m(t) {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

function m2t(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function todayMadrid() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function nowMinutesMadrid() {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date());
  return t2m(s);
}

function addDays(date, n) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(date + 'T00:00:00Z').getUTCDay();
}

function isBusinessDay(date) {
  const d = weekday(date);
  return d >= 1 && d <= 5;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function initialsName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { fn: parts[0] || 'Paciente', ln: parts.slice(1).join(' ') || 'Sin apellido' };
}

/* ------------------------------------------------------------------- config */

let configCache = { at: 0, data: null };

async function loadConfig(force = false) {
  const now = Date.now();
  if (!force && configCache.data && now - configCache.at < 5 * 60 * 1000) return configCache.data;

  const [clinicSnap, treatmentsSnap, dentistsSnap] = await Promise.all([
    db.doc('settings/clinic').get(),
    db.collection('treatments').get(),
    db.collection('dentists').get()
  ]);

  const clinic = clinicSnap.exists ? clinicSnap.data() : {};
  const treatments = treatmentsSnap.empty
    ? DEFAULT_TREATMENTS
    : treatmentsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.active !== false);
  const dentists = dentistsSnap.empty
    ? DEFAULT_DENTISTS
    : dentistsSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.active !== false);

  const slots = Array.isArray(clinic.slots) && clinic.slots.length ? clinic.slots : DEFAULT_SLOTS;
  const data = {
    clinic: {
      name: clinic.name || 'Clínica Dental Aurora',
      addr: clinic.addr || 'Calle de la Luz 24, 28004 Madrid',
      phone: clinic.phone || '+34 910 000 000',
      email: clinic.email || 'info@clinicaaurora.example',
      timezone: clinic.timezone || 'Europe/Madrid',
      slots,
      breakStart: clinic.breakStart || '14:00',
      breakEnd: clinic.breakEnd || '16:00',
      openEnd: clinic.openEnd || '20:00',
      privacyVersion: clinic.privacyVersion || '2026-01',
      bookingHoldHours: Number(clinic.bookingHoldHours || 24)
    },
    treatments,
    dentists
  };
  configCache = { at: now, data };
  return data;
}

function treatmentOf(config, id) {
  const t = config.treatments.find((x) => x.id === id && x.active !== false);
  if (!t) throw new HttpsError('invalid-argument', 'Tratamiento no válido.');
  return t;
}

function dentistsFor(config, treatment) {
  const allowed = Array.isArray(treatment.dentistIds) && treatment.dentistIds.length
    ? treatment.dentistIds
    : config.dentists.map((d) => d.id);
  const list = config.dentists.filter((d) => allowed.includes(d.id));
  if (!list.length) throw new HttpsError('failed-precondition', 'No hay odontólogos disponibles para este tratamiento.');
  return list;
}

function validWindow(config, date, time, durationMin) {
  if (!isBusinessDay(date)) return 'La clínica cierra los fines de semana.';
  if (!config.clinic.slots.includes(time)) return 'La hora no está dentro del horario de la clínica.';
  const start = t2m(time);
  const end = start + durationMin;
  const breakStart = t2m(config.clinic.breakStart);
  const breakEnd = t2m(config.clinic.breakEnd);
  const openEnd = t2m(config.clinic.openEnd);
  if (start < breakStart && end > breakStart) return 'La cita invade la pausa de mediodía.';
  if (end > openEnd) return 'La cita terminaría fuera del horario de la clínica.';
  if (date === todayMadrid() && start <= nowMinutesMadrid() + 60) return 'Ese hueco ya no está disponible hoy.';
  return '';
}

function lockRef(date, dentistId) {
  return db.doc(`scheduleLocks/${date}_${dentistId}`);
}

function cleanIntervals(intervals, now = Date.now()) {
  if (!Array.isArray(intervals)) return [];
  return intervals.filter((i) => {
    if (!i || typeof i.start !== 'number' || typeof i.end !== 'number') return false;
    if (i.type === 'request' && Number(i.expiresAt || 0) <= now) return false;
    return true;
  });
}

function overlaps(intervals, start, end, ignore) {
  return intervals.some((i) => {
    if (ignore && (
      (ignore.requestId && i.requestId === ignore.requestId) ||
      (ignore.appointmentId && i.appointmentId === ignore.appointmentId)
    )) return false;
    return start < i.end && i.start < end;
  });
}

async function rateLimit(request, action, max, windowMs) {
  const salt = process.env.RATE_LIMIT_SALT || 'aurora';
  const forwarded = String(request.rawRequest?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = forwarded || request.rawRequest?.ip || 'unknown';
  const id = hash(salt + '|' + action + '|' + ip);
  const ref = db.doc('rateLimits/' + id);
  const now = Date.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    const start = data && Number(data.windowStart || 0) > now - windowMs ? Number(data.windowStart) : now;
    const count = start === now ? 1 : Number(data.count || 0) + 1;
    if (count > max) {
      throw new HttpsError('resource-exhausted', 'Demasiadas solicitudes. Espera unos minutos y vuelve a intentarlo.');
    }
    tx.set(ref, { action, windowStart: start, count, updatedAt: Timestamp.now() }, { merge: true });
  });
}

async function patientUserId(patientId) {
  if (!patientId) return null;
  const snap = await db.doc('patients/' + patientId).get();
  return snap.exists ? (snap.data().userId || null) : null;
}

// Los odontólogos del catálogo usan IDs estables (d1, d2...) y se vinculan a
// una cuenta de Authentication mediante users/{uid}.dentistId. Las reglas y
// las Functions nunca comparan el ID de catálogo con el UID de la cuenta.
let dentistUsersCache = { at: 0, data: [] };
async function dentistUsers(force = false) {
  const now = Date.now();
  if (!force && dentistUsersCache.data.length && now - dentistUsersCache.at < 5 * 60 * 1000) {
    return dentistUsersCache.data;
  }
  const snap = await db.collection('users')
    .where('role', '==', 'dentist')
    .where('status', '==', 'active')
    .limit(50).get();
  const data = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  dentistUsersCache = { at: now, data };
  return data;
}

async function dentistUidFor(dentistId) {
  if (!dentistId) return '';
  const list = await dentistUsers();
  const found = list.find((u) => u.dentistId === dentistId);
  return found ? found.uid : '';
}

async function dentistProfileFor(uid) {
  if (!uid) return null;
  const snap = await db.doc('users/' + uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  return { uid, ...data, dentistId: String(data.dentistId || '') };
}

async function addCareTeam(tx, patientId, dentistId, now) {
  if (!patientId || !dentistId) return;
  const ref = db.doc('patients/' + patientId);
  const snap = await tx.get(ref);
  if (!snap.exists) return;
  const patient = snap.data();
  const patch = { updatedAt: now };
  if (!patient.assignedDentistId) patch.assignedDentistId = dentistId;
  const team = Array.isArray(patient.careTeamIds) ? patient.careTeamIds : [];
  if (!team.includes(dentistId)) patch.careTeamIds = [...new Set([...team, dentistId])];
  if (Object.keys(patch).length > 1) tx.set(ref, patch, { merge: true });
}

async function notification(userId, data) {
  if (!userId) return;
  await db.collection('notifications').add({
    userId,
    type: data.type || 'info',
    title: String(data.title || 'Clínica Dental Aurora').slice(0, 160),
    body: String(data.body || '').slice(0, 1200),
    link: data.link || '',
    read: false,
    createdAt: Timestamp.now()
  });
}

async function audit(actor, action, entity, entityId, extra = {}) {
  await db.collection('auditLogs').add({
    actorUid: actor?.uid || 'system',
    actorRole: actor?.role || 'system',
    action,
    entity,
    entityId: entityId || '',
    at: Timestamp.now(),
    ...extra
  });
}

/* ------------------------------------------------------------- registration */

exports.registerPatient = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  await rateLimit(request, 'register', 5, 60 * 60 * 1000);

  const name = clean(request.data?.name, 120, { min: 2, label: 'nombre' });
  const mail = email(request.data?.email);
  const tel = phone(request.data?.phone, true);
  const password = String(request.data?.password || '');
  if (password.length < 8) throw new HttpsError('invalid-argument', 'La contraseña debe tener al menos 8 caracteres.');
  if (password.length > 128) throw new HttpsError('invalid-argument', 'La contraseña es demasiado larga.');
  if (request.data?.consent !== true) throw new HttpsError('invalid-argument', 'Debes aceptar la política de privacidad.');

  let possibleMatch = null;
  try {
    const q = await db.collection('patients').where('em', '==', mail).limit(1).get();
    if (!q.empty) possibleMatch = { id: q.docs[0].id, ...q.docs[0].data() };
  } catch (error) {
    logger.warn('No se pudo buscar una ficha previa', error);
  }

  if (possibleMatch?.userId) {
    throw new HttpsError('already-exists', 'Ya existe una cuenta vinculada a ese correo. Inicia sesión o recupera tu contraseña.');
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({
      email: mail,
      password,
      displayName: name,
      emailVerified: false
    });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Ya existe una cuenta con ese correo. Inicia sesión o recupera tu contraseña.');
    }
    throw new HttpsError('internal', 'No se pudo crear la cuenta.');
  }

  const uid = userRecord.uid;
  // No se vincula automáticamente una ficha preexistente por correo: un tercero
  // podría registrarse con el correo de un paciente y leer su historial. La
  // vinculación la autoriza recepción/administración tras verificar identidad.
  const patientId = uid;
  const parts = initialsName(name);
  const now = Timestamp.now();

  try {
    await admin.auth().setCustomUserClaims(uid, { role: 'patient' });

    const batch = db.batch();
    batch.set(db.doc('users/' + uid), {
      uid,
      email: mail,
      name,
      phone: tel,
      role: 'patient',
      status: 'active',
      patientId,
      preferences: {
        lang: 'es',
        theme: 'system',
        motion: 'system',
        notifications: { email: true, sms: false },
        a11y: { scale: 1, line: false, spacing: false, readable: false, contrast: false, hover: true }
      },
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now
    }, { merge: true });

    batch.set(db.doc('patients/' + patientId), {
      fn: parts.fn,
      ln: parts.ln,
      bd: '',
      ph: tel,
      em: mail,
      addr: '',
      assignedDentistId: '',
      userId: uid,
      status: 'active',
      searchName: `${parts.fn} ${parts.ln} ${mail}`.toLowerCase(),
      createdAt: now,
      createdBy: 'self-registration',
      updatedAt: now
    }, { merge: true });

    batch.set(db.collection('notifications').doc(), {
      userId: uid,
      type: 'welcome',
      title: 'Bienvenido/a a Clínica Dental Aurora',
      body: 'Tu cuenta de paciente está activa. Desde aquí puedes consultar tus citas, pagos y resúmenes clínicos compartidos.',
      read: false,
      createdAt: now
    });

    await batch.commit();
    await audit({ uid, role: 'patient' }, 'patient.register', 'patients', patientId, { patientId, possibleMatchId: possibleMatch?.id || '' });

    const customToken = await admin.auth().createCustomToken(uid, { role: 'patient' });
    return { ok: true, customToken, uid, patientId, possibleMatchId: possibleMatch?.id || '' };
  } catch (error) {
    try { await admin.auth().deleteUser(uid); } catch (cleanupError) { logger.error('No se pudo revertir la cuenta', cleanupError); }
    logger.error('Error al registrar paciente', error);
    throw new HttpsError('internal', 'No se pudo completar el registro. Inténtalo de nuevo.');
  }
});

/* ---------------------------------------------------------- public booking */

exports.publicAvailability = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const config = await loadConfig();
  const treatmentId = clean(request.data?.treatment || 'revision', 40, { label: 'tratamiento' });
  const treatment = treatmentOf(config, treatmentId);
  const dentists = dentistsFor(config, treatment);
  const pref = clean(request.data?.dentistId || 'any', 40);
  const candidates = pref === 'any' ? dentists : dentists.filter((d) => d.id === pref);
  const usable = candidates.length ? candidates : dentists;
  const days = Number(request.data?.days || 14);
  if (days < 1 || days > 31) throw new HttpsError('invalid-argument', 'Número de días no válido.');

  const dates = [];
  let cursor = todayMadrid();
  for (let i = 0; i < 60 && dates.length < days; i += 1) {
    if (isBusinessDay(cursor)) dates.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const refs = [];
  for (const date of dates) for (const dentist of usable) refs.push(lockRef(date, dentist.id));
  const snapshots = refs.length ? await db.getAll(...refs) : [];
  const locks = new Map();
  snapshots.forEach((snap) => {
    if (snap.exists) locks.set(snap.id, cleanIntervals(snap.data().intervals || []));
    else locks.set(snap.id, []);
  });

  const now = Date.now();
  const slots = [];
  for (const date of dates) {
    for (const dentist of usable) {
      const intervals = cleanIntervals(locks.get(`${date}_${dentist.id}`) || [], now);
      for (const time of config.clinic.slots) {
        if (validWindow(config, date, time, treatment.min)) continue;
        const start = t2m(time);
        const end = start + treatment.min;
        if (overlaps(intervals, start, end)) continue;
        slots.push({ date, time, dentistId: dentist.id, treatment: treatment.id });
      }
    }
  }

  return {
    ok: true,
    treatment: treatment.id,
    duration: treatment.min,
    generatedAt: new Date().toISOString(),
    days: dates,
    slots
  };
});

exports.publicBooking = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  await rateLimit(request, 'booking', 12, 60 * 60 * 1000);

  const name = clean(request.data?.name, 120, { min: 3, label: 'nombre' });
  if (name.split(/\s+/).filter(Boolean).length < 2) {
    throw new HttpsError('invalid-argument', 'Escribe nombre y al menos un apellido.');
  }
  const mail = email(request.data?.email);
  const tel = phone(request.data?.phone, false);
  const treatmentId = clean(request.data?.treatment, 40, { label: 'tratamiento' });
  const date = assertDate(request.data?.date);
  const time = assertTime(request.data?.time);
  const pref = clean(request.data?.dentistId || 'any', 40);
  const msg = cleanMultiline(request.data?.msg || '', 500);
  if (request.data?.consent !== true) throw new HttpsError('invalid-argument', 'Debes aceptar la política de privacidad.');

  const config = await loadConfig();
  const treatment = treatmentOf(config, treatmentId);
  const windowError = validWindow(config, date, time, treatment.min);
  if (windowError) throw new HttpsError('invalid-argument', windowError);

  const allDentists = dentistsFor(config, treatment);
  const preferred = pref !== 'any' ? allDentists.filter((d) => d.id === pref) : [];
  const ordered = [...preferred, ...allDentists.filter((d) => !preferred.some((p) => p.id === d.id))];
  const start = t2m(time);
  const end = start + treatment.min;
  const now = Timestamp.now();
  const holdUntilMs = Date.now() + Number(config.clinic.bookingHoldHours || 24) * 60 * 60 * 1000;

  for (const dentist of ordered) {
    const lock = lockRef(date, dentist.id);
    const requestRef = db.collection('requests').doc();
    const counterRef = db.doc('counters/requests');
    try {
      const result = await db.runTransaction(async (tx) => {
        const lockSnap = await tx.get(lock);
        const intervals = cleanIntervals(lockSnap.exists ? lockSnap.data().intervals || [] : []);
        if (overlaps(intervals, start, end)) return { taken: true };

        const counterSnap = await tx.get(counterRef);
        const next = Number(counterSnap.exists ? counterSnap.data().value || 0 : 0) + 1;
        const ref = `AUR-${new Date().getFullYear()}-${String(next).padStart(4, '0')}`;

        tx.set(lock, {
          date,
          dentistId: dentist.id,
          intervals: [...intervals, {
            start, end, type: 'request', requestId: requestRef.id,
            expiresAt: holdUntilMs
          }],
          updatedAt: now
        }, { merge: true });

        tx.set(counterRef, { value: next, updatedAt: now }, { merge: true });

        tx.set(requestRef, {
          kind: 'booking',
          ref,
          name,
          phone: tel,
          email: mail,
          treatment: treatment.id,
          dentistId: dentist.id,
          prefDentist: pref,
          date,
          time,
          msg,
          channel: 'email',
          status: 'new',
          source: 'web',
          consent: { privacy: true, version: config.clinic.privacyVersion, at: now },
          holdExpiresAt: Timestamp.fromMillis(holdUntilMs),
          createdAt: now,
          updatedAt: now
        });

        return { taken: false, ref, requestId: requestRef.id };
      });

      if (!result.taken) {
        return {
          ok: true,
          ref: result.ref,
          date,
          time,
          dentistId: dentist.id,
          treatment: treatment.id,
          requestId: result.requestId
        };
      }
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.warn('Conflicto al reservar, probando otro odontólogo', { dentist: dentist.id, error: error.message });
    }
  }

  throw new HttpsError('already-exists', 'Ese hueco se acaba de ocupar. Elige otro, por favor.');
});

exports.publicContact = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  await rateLimit(request, 'contact', 20, 60 * 60 * 1000);

  const name = clean(request.data?.name, 120, { min: 3, label: 'nombre' });
  const mail = request.data?.email ? email(request.data.email) : '';
  const tel = phone(request.data?.phone, false);
  const channel = ['call', 'sms', 'email'].includes(request.data?.channel) ? request.data.channel : 'call';
  if (channel === 'email' && !mail) throw new HttpsError('invalid-argument', 'Indica un correo para responder.');
  if (channel !== 'email' && !tel) throw new HttpsError('invalid-argument', 'Indica un teléfono para la llamada o el SMS.');
  if (request.data?.consent !== true) throw new HttpsError('invalid-argument', 'Debes aceptar la política de privacidad.');

  const now = Timestamp.now();
  const doc = await db.collection('requests').add({
    kind: 'callback',
    ref: `WEB-${Date.now().toString(36).toUpperCase()}`,
    name,
    phone: tel,
    email: mail,
    treatment: clean(request.data?.treatment || 'otro', 40),
    when: ['am', 'pm', 'any'].includes(request.data?.when) ? request.data.when : 'any',
    channel,
    date: '',
    time: '',
    msg: cleanMultiline(request.data?.msg || '', 500),
    status: 'new',
    source: 'web',
    consent: { privacy: true, at: now },
    createdAt: now,
    updatedAt: now
  });

  return { ok: true, requestId: doc.id, ref: (await doc.get()).data().ref };
});

/* ---------------------------------------------------------------- patients */

exports.patientRequestChange = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['patient']);
  await rateLimit(request, 'change-request', 10, 60 * 60 * 1000);

  const appointmentId = clean(request.data?.appointmentId, 120, { label: 'cita' });
  const message = cleanMultiline(request.data?.message, 1000, { min: 5, label: 'mensaje' });
  const apptSnap = await db.doc('appointments/' + appointmentId).get();
  if (!apptSnap.exists) throw new HttpsError('not-found', 'La cita no existe.');
  const appt = apptSnap.data();

  const userSnap = await db.doc('users/' + auth.uid).get();
  const patientId = userSnap.exists ? userSnap.data().patientId : auth.uid;
  const patientSnap = await db.doc('patients/' + (appt.patientId || '')).get();
  const owns = appt.patientId === patientId || appt.patientId === auth.uid ||
    (patientSnap.exists && patientSnap.data().userId === auth.uid);
  if (!owns) throw new HttpsError('permission-denied', 'Esa cita no pertenece a tu cuenta.');

  const now = Timestamp.now();
  const patient = patientSnap.exists ? patientSnap.data() : {};
  const req = await db.collection('requests').add({
    kind: 'change',
    name: patient.fn ? `${patient.fn} ${patient.ln || ''}`.trim() : (userSnap.data()?.name || 'Paciente'),
    phone: userSnap.data()?.phone || '',
    email: userSnap.data()?.email || '',
    patientId: appt.patientId,
    appointmentId,
    treatment: appt.treatment,
    dentistId: appt.dentistId,
    date: appt.date,
    time: appt.time,
    msg: message,
    status: 'new',
    source: 'patient-portal',
    createdAt: now,
    updatedAt: now
  });

  await db.doc('appointments/' + appointmentId).update({ req: message, updatedAt: now });
  await audit(auth, 'appointment.change_request', 'appointments', appointmentId, { patientId: appt.patientId });
  return { ok: true, requestId: req.id };
});

/* --------------------------------------------------------- staff callables */

exports.adminSaveAppointment = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception']);
  const config = await loadConfig();
  const id = request.data?.id ? String(request.data.id) : '';
  const patientId = clean(request.data?.patientId, 120, { label: 'paciente' });
  const treatment = treatmentOf(config, clean(request.data?.treatment, 40));
  const dentist = config.dentists.find((d) => d.id === clean(request.data?.dentistId, 40));
  if (!dentist) throw new HttpsError('invalid-argument', 'Odontólogo no válido.');
  if (!dentistsFor(config, treatment).some((d) => d.id === dentist.id)) {
    throw new HttpsError('invalid-argument', 'Ese odontólogo no realiza este tratamiento.');
  }
  const date = assertDate(request.data?.date);
  const time = assertTime(request.data?.time);
  const status = APPT_STATUS.includes(request.data?.status) ? request.data.status : 'confirmed';
  // Las notas internas no se guardan en la cita porque el paciente puede leer su
  // propia cita. Cualquier detalle clínico va en consultations/summaries.
  const note = '';
  const box = clean(request.data?.box || (dentist.id === 'd1' ? 'Gabinete 1' : 'Gabinete 2'), 60);
  const windowError = validWindow(config, date, time, treatment.min);
  if (windowError) throw new HttpsError('invalid-argument', windowError);

  const patientSnap = await db.doc('patients/' + patientId).get();
  if (!patientSnap.exists) throw new HttpsError('not-found', 'Paciente no encontrado.');
  const patient = patientSnap.data();
  if (patient.status && patient.status !== 'active') {
    throw new HttpsError('failed-precondition', 'La ficha del paciente no está activa.');
  }

  const start = t2m(time);
  const end = start + treatment.min;
  const apptRef = id ? db.doc('appointments/' + id) : db.collection('appointments').doc();
  const newLock = lockRef(date, dentist.id);
  const now = Timestamp.now();
  const dentistUid = await dentistUidFor(dentist.id);

  const result = await db.runTransaction(async (tx) => {
    const existing = id ? await tx.get(apptRef) : null;
    const before = existing && existing.exists ? existing.data() : null;
    if (id && !before) throw new HttpsError('not-found', 'La cita no existe.');

    const oldLockRef = before && (before.date !== date || before.dentistId !== dentist.id)
      ? lockRef(before.date, before.dentistId)
      : null;
    const oldLockSnap = oldLockRef ? await tx.get(oldLockRef) : null;
    const lockSnap = oldLockRef && oldLockRef.path === newLock.path ? oldLockSnap : await tx.get(newLock);
    await addCareTeam(tx, patientId, dentist.id, now);

    let newIntervals = cleanIntervals(lockSnap && lockSnap.exists ? lockSnap.data().intervals || [] : []);
    if (before) {
      newIntervals = newIntervals.filter((i) => i.appointmentId !== apptRef.id);
    }
    if (oldLockRef && oldLockRef.path !== newLock.path) {
      let oldIntervals = cleanIntervals(oldLockSnap && oldLockSnap.exists ? oldLockSnap.data().intervals || [] : []);
      oldIntervals = oldIntervals.filter((i) => i.appointmentId !== apptRef.id);
      if (oldLockRef.path === newLock.path) newIntervals = oldIntervals;
      else {
        tx.set(oldLockRef, {
          date: before.date, dentistId: before.dentistId,
          intervals: oldIntervals, updatedAt: now
        }, { merge: true });
      }
    }
    if (overlaps(newIntervals, start, end, { appointmentId: apptRef.id })) {
      throw new HttpsError('already-exists', 'Ese odontólogo ya tiene una cita o una solicitud en ese horario.');
    }

    if (status !== 'cancelled') {
      newIntervals.push({
        start, end, type: 'appointment', appointmentId: apptRef.id,
        patientId, dentistId: dentist.id
      });
    }

    const data = {
      patientId,
      patientName: `${patient.fn || ''} ${patient.ln || ''}`.trim(),
      treatment: treatment.id,
      treatmentName: treatment.n,
      dentistId: dentist.id,
      dentistUid,
      dentistName: dentist.n,
      date,
      time,
      status,
      box,
      note,
      req: before?.req || '',
      requestId: before?.requestId || '',
      createdAt: before?.createdAt || now,
      updatedAt: now,
      createdBy: before?.createdBy || auth.uid,
      updatedBy: auth.uid
    };

    tx.set(newLock, {
      date, dentistId: dentist.id, intervals: newIntervals, updatedAt: now
    }, { merge: true });
    tx.set(apptRef, data, { merge: true });

    const logRef = db.collection('auditLogs').doc();
    tx.set(logRef, {
      actorUid: auth.uid, actorRole: auth.role,
      action: id ? 'appointment.update' : 'appointment.create',
      entity: 'appointments', entityId: apptRef.id, patientId,
      at: now, meta: { date, time, dentistId: dentist.id, status }
    });

    return { id: apptRef.id, data };
  });

  return { ok: true, id: result.id, appointment: result.data };
});

exports.adminUpdateAppointmentStatus = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception', 'dentist']);
  const id = clean(request.data?.id, 120, { label: 'cita' });
  const status = clean(request.data?.status, 20);
  if (!APPT_STATUS.includes(status)) throw new HttpsError('invalid-argument', 'Estado no válido.');

  const config = await loadConfig();
  const configTreatment = config.treatments.find((t) => t.id === request.data?.treatment);
  const apptRef = db.doc('appointments/' + id);
  const now = Timestamp.now();
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(apptRef);
    if (!snap.exists) throw new HttpsError('not-found', 'La cita no existe.');
    const appt = snap.data();
    if (auth.role === 'dentist') {
      const profile = await dentistProfileFor(auth.uid);
      const own = appt.dentistUid === auth.uid ||
        appt.dentistId === auth.uid ||
        (profile && profile.dentistId && appt.dentistId === profile.dentistId);
      if (!own) throw new HttpsError('permission-denied', 'Solo puedes gestionar tus propias citas.');
    }
    if (appt.status === status) return;

    const lock = lockRef(appt.date, appt.dentistId);
    const lockSnap = await tx.get(lock);
    let intervals = cleanIntervals(lockSnap.exists ? lockSnap.data().intervals || [] : []);
    intervals = intervals.filter((i) => i.appointmentId !== id);

    if (status !== 'cancelled') {
      const treatment = config.treatments.find((t) => t.id === appt.treatment) || configTreatment;
      const dur = treatment ? treatment.min : 30;
      const start = t2m(appt.time);
      if (overlaps(intervals, start, start + dur)) {
        throw new HttpsError('already-exists', 'No se puede reactivar: el hueco ya está ocupado.');
      }
      intervals.push({ start, end: start + dur, type: 'appointment', appointmentId: id, patientId: appt.patientId, dentistId: appt.dentistId });
    }

    tx.set(lock, { date: appt.date, dentistId: appt.dentistId, intervals, updatedAt: now }, { merge: true });
    tx.update(apptRef, { status, updatedAt: now, updatedBy: auth.uid });
    tx.set(db.collection('auditLogs').doc(), {
      actorUid: auth.uid, actorRole: auth.role,
      action: 'appointment.status', entity: 'appointments', entityId: id,
      patientId: appt.patientId, at: now, meta: { status }
    });
  });

  return { ok: true };
});

exports.acceptRequest = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception']);
  const requestId = clean(request.data?.id, 120, { label: 'solicitud' });
  const reqRef = db.doc('requests/' + requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'La solicitud no existe.');
  const req = reqSnap.data();
  if (req.status !== 'new') throw new HttpsError('failed-precondition', 'La solicitud ya se ha gestionado.');

  const now = Timestamp.now();
  if (!req.date || !req.time) {
    await reqRef.update({ status: 'accepted', updatedAt: now, updatedBy: auth.uid });
    await audit(auth, 'request.accept_callback', 'requests', requestId);
    return { ok: true, type: 'callback' };
  }

  const config = await loadConfig();
  const treatment = treatmentOf(config, req.treatment === 'otro' ? 'revision' : req.treatment);
  let dentistId = req.dentistId;
  const dentist = config.dentists.find((d) => d.id === dentistId && dentistsFor(config, treatment).some((x) => x.id === d.id))
    || dentistsFor(config, treatment)[0];
  if (!dentist) throw new HttpsError('failed-precondition', 'No hay odontólogo disponible.');
  dentistId = dentist.id;
  const date = assertDate(req.date);
  const time = assertTime(req.time);
  const start = t2m(time);
  const end = start + treatment.min;
  const appointmentId = 'reqappt_' + requestId;
  const apptRef = db.doc('appointments/' + appointmentId);
  const lock = lockRef(date, dentistId);
  const dentistUid = await dentistUidFor(dentistId);

  let patientId = req.patientId || '';
  if (!patientId) {
    const byEmail = req.email
      ? await db.collection('patients').where('em', '==', String(req.email).toLowerCase()).limit(1).get()
      : { empty: true, docs: [] };
    if (!byEmail.empty) patientId = byEmail.docs[0].id;
  }
  if (!patientId) {
    const key = String(req.email || req.phone || req.name).toLowerCase();
    patientId = 'auto_' + hash(key).slice(0, 24);
  }
  const patientRef = db.doc('patients/' + patientId);
  const patientSnap = await patientRef.get();
  const existingPatient = patientSnap.exists ? patientSnap.data() : null;
  const parts = initialsName(req.name);

  const result = await db.runTransaction(async (tx) => {
    const freshReq = await tx.get(reqRef);
    if (!freshReq.exists) throw new HttpsError('not-found', 'La solicitud no existe.');
    if (freshReq.data().status !== 'new') throw new HttpsError('failed-precondition', 'La solicitud ya se ha gestionado.');

    const existingAppt = await tx.get(apptRef);
    if (existingAppt.exists) {
      tx.update(reqRef, { status: 'accepted', patientId, appointmentId, updatedAt: now, updatedBy: auth.uid });
      return { appointmentId, patientId, already: true };
    }

    const lockSnap = await tx.get(lock);
    let intervals = cleanIntervals(lockSnap.exists ? lockSnap.data().intervals || [] : []);
    intervals = intervals.filter((i) => i.requestId !== requestId && i.appointmentId !== appointmentId);
    await addCareTeam(tx, patientId, dentistId, now);

    // The web hold may have been placed on a different dentist (preferred one was
    // busy). Release that hold so the rejected slot is not blocked until expiry.
    const heldDentistId = req.dentistId && req.dentistId !== 'any' ? req.dentistId : '';
    if (heldDentistId && heldDentistId !== dentistId) {
      const oldLock = lockRef(date, heldDentistId);
      const oldSnap = await tx.get(oldLock);
      if (oldSnap.exists) {
        const released = cleanIntervals(oldSnap.data().intervals || [])
          .filter((i) => i.requestId !== requestId);
        tx.set(oldLock, { date, dentistId: heldDentistId, intervals: released, updatedAt: now }, { merge: true });
      }
    }

    if (overlaps(intervals, start, end)) {
      throw new HttpsError('already-exists', 'Ese hueco ya está ocupado. Cambia la hora desde Citas.');
    }
    intervals.push({ start, end, type: 'appointment', appointmentId, requestId, patientId, dentistId });

    if (!existingPatient) {
      tx.set(patientRef, {
        fn: parts.fn, ln: parts.ln, bd: '', ph: req.phone || '', em: req.email || '',
        addr: '', assignedDentistId: dentistId, userId: '', status: 'active',
        searchName: `${parts.fn} ${parts.ln} ${req.email || ''}`.toLowerCase(),
        createdAt: now, createdBy: auth.uid, updatedAt: now
      });
    } else if (!existingPatient.assignedDentistId) {
      tx.update(patientRef, { assignedDentistId: dentistId, updatedAt: now });
    }

    tx.set(lock, { date, dentistId, intervals, updatedAt: now }, { merge: true });
    tx.set(apptRef, {
      patientId,
      patientName: `${existingPatient?.fn || parts.fn} ${existingPatient?.ln || parts.ln}`.trim(),
      treatment: treatment.id,
      treatmentName: treatment.n,
      dentistId,
      dentistUid,
      dentistName: dentist.n,
      date, time, status: 'confirmed',
      box: dentistId === 'd1' ? 'Gabinete 1' : 'Gabinete 2',
      note: '',
      req: '',
      requestId,
      createdAt: now,
      updatedAt: now,
      createdBy: auth.uid,
      updatedBy: auth.uid
    });

    tx.update(reqRef, { status: 'accepted', patientId, appointmentId, updatedAt: now, updatedBy: auth.uid });
    tx.set(db.collection('auditLogs').doc(), {
      actorUid: auth.uid, actorRole: auth.role,
      action: 'request.accept', entity: 'requests', entityId: requestId,
      patientId, at: now, meta: { appointmentId, date, time, dentistId }
    });
    return { appointmentId, patientId, already: false };
  });

  return { ok: true, type: 'appointment', ...result };
});

exports.rejectRequest = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception']);
  const requestId = clean(request.data?.id, 120, { label: 'solicitud' });
  const reqRef = db.doc('requests/' + requestId);
  const now = Timestamp.now();

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(reqRef);
    if (!snap.exists) throw new HttpsError('not-found', 'La solicitud no existe.');
    const req = snap.data();
    if (req.status !== 'new') throw new HttpsError('failed-precondition', 'La solicitud ya se ha gestionado.');

    if (req.date && (req.dentistId || req.prefDentist)) {
      const dentistId = req.dentistId || req.prefDentist;
      if (dentistId && dentistId !== 'any') {
        const lock = lockRef(req.date, dentistId);
        const lockSnap = await tx.get(lock);
        const intervals = cleanIntervals(lockSnap.exists ? lockSnap.data().intervals || [] : [])
          .filter((i) => i.requestId !== requestId);
        tx.set(lock, { date: req.date, dentistId, intervals, updatedAt: now }, { merge: true });
      }
    }

    tx.update(reqRef, { status: 'rejected', updatedAt: now, updatedBy: auth.uid });
    tx.set(db.collection('auditLogs').doc(), {
      actorUid: auth.uid, actorRole: auth.role,
      action: 'request.reject', entity: 'requests', entityId: requestId,
      patientId: req.patientId || '', at: now
    });
  });

  return { ok: true };
});

exports.saveConsultation = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'dentist']);
  const patientId = clean(request.data?.patientId, 120, { label: 'paciente' });
  const date = assertDate(request.data?.date || todayMadrid());
  const config = await loadConfig();
  const treatmentId = clean(request.data?.treatment, 40, { label: 'tratamiento' });
  const treatment = treatmentOf(config, treatmentId);

  let dentistId;
  let dentistUid = '';
  if (auth.role === 'dentist') {
    const profile = await dentistProfileFor(auth.uid);
    dentistId = String(profile?.dentistId || '');
    if (!dentistId) throw new HttpsError('failed-precondition', 'Tu cuenta no está vinculada a un odontólogo del catálogo.');
    dentistUid = auth.uid;
  } else {
    dentistId = clean(request.data?.dentistId || '', 120);
    if (!dentistId) throw new HttpsError('invalid-argument', 'Falta el odontólogo.');
    if (!config.dentists.some((d) => d.id === dentistId)) {
      throw new HttpsError('invalid-argument', 'El odontólogo no está en el catálogo.');
    }
    dentistUid = await dentistUidFor(dentistId);
  }
  const dentist = config.dentists.find((d) => d.id === dentistId) || {};

  const notes = cleanMultiline(request.data?.notes, 20000, { min: 1, label: 'observaciones' });
  const diagnosis = cleanMultiline(request.data?.diagnosis || '', 10000);
  const plan = cleanMultiline(request.data?.plan || '', 10000);
  const evolution = cleanMultiline(request.data?.evolution || '', 10000);
  const sharedSummary = cleanMultiline(request.data?.sharedSummary || '', 5000);
  const share = request.data?.share === true && !!sharedSummary;
  const appointmentId = request.data?.appointmentId ? String(request.data.appointmentId) : '';

  const patientSnap = await db.doc('patients/' + patientId).get();
  if (!patientSnap.exists) throw new HttpsError('not-found', 'Paciente no encontrado.');
  const patient = patientSnap.data();
  if (auth.role === 'dentist') {
    const team = Array.isArray(patient.careTeamIds) ? patient.careTeamIds : [];
    if (patient.assignedDentistId !== dentistId && !team.includes(dentistId)) {
      throw new HttpsError('permission-denied', 'Solo puedes registrar consultas de pacientes asignados.');
    }
  }

  const now = Timestamp.now();
  const ref = await db.collection('consultations').add({
    patientId,
    patientName: `${patient.fn || ''} ${patient.ln || ''}`.trim(),
    appointmentId,
    date,
    treatment: treatment.id,
    treatmentName: treatment.n,
    dentistId,
    dentistUid,
    dentistName: dentist.n || '',
    notes,
    diagnosis,
    plan,
    evolution,
    sharedSummary,
    share,
    visibleToPatient: share,
    attachments: [],
    createdAt: now,
    updatedAt: now,
    createdBy: auth.uid,
    updatedBy: auth.uid
  });

  await audit(auth, 'consultation.create', 'consultations', ref.id, { patientId });
  return { ok: true, id: ref.id };
});

exports.updateConsultationShare = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'dentist']);
  const id = clean(request.data?.id, 120, { label: 'consulta' });
  const share = request.data?.share === true;
  const ref = db.doc('consultations/' + id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'La consulta no existe.');
  const data = snap.data();
  if (auth.role === 'dentist') {
    const profile = await dentistProfileFor(auth.uid);
    const own = data.dentistUid === auth.uid ||
      data.dentistId === auth.uid ||
      (profile && profile.dentistId && data.dentistId === profile.dentistId);
    if (!own) throw new HttpsError('permission-denied', 'Solo puedes compartir tus propias consultas.');
  }
  if (share && !String(data.sharedSummary || '').trim()) {
    throw new HttpsError('failed-precondition', 'Escribe primero un resumen para el paciente.');
  }
  await ref.update({ share, visibleToPatient: share, updatedAt: Timestamp.now(), updatedBy: auth.uid });
  await audit(auth, share ? 'consultation.share' : 'consultation.unshare', 'consultations', id, { patientId: data.patientId });
  return { ok: true };
});

exports.adminSetUserRole = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin']);
  const uid = clean(request.data?.uid, 128, { label: 'usuario' });
  const role = assertRole(clean(request.data?.role, 20));
  if (uid === auth.uid && role !== 'admin') {
    throw new HttpsError('failed-precondition', 'No puedes retirar tu propio rol de administrador.');
  }
  const userSnap = await db.doc('users/' + uid).get();
  if (!userSnap.exists) throw new HttpsError('not-found', 'El usuario no existe.');
  const profile = userSnap.data();
  let dentistId = '';
  if (role === 'dentist') {
    dentistId = clean(request.data?.dentistId || profile.dentistId || '', 40);
    if (!dentistId) {
      throw new HttpsError('failed-precondition', 'El usuario necesita un odontólogo del catálogo para tener el rol de odontólogo.');
    }
  }
  await admin.auth().setCustomUserClaims(uid, { role });
  await db.doc('users/' + uid).update({
    role,
    ...(role === 'dentist' ? { dentistId } : {}),
    updatedAt: Timestamp.now(),
    updatedBy: auth.uid
  });
  await audit(auth, 'user.role', 'users', uid, { meta: { role } });
  return { ok: true };
});

exports.adminCreateStaffUser = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin']);
  const name = clean(request.data?.name, 120, { min: 2, label: 'nombre' });
  const mail = email(request.data?.email);
  const role = assertRole(clean(request.data?.role, 20));
  if (role === 'patient') throw new HttpsError('invalid-argument', 'Usa el registro de pacientes para ese rol.');
  const password = String(request.data?.password || '');
  if (password.length < 10) throw new HttpsError('invalid-argument', 'La contraseña temporal debe tener al menos 10 caracteres.');
  let dentistId = '';
  if (role === 'dentist') {
    dentistId = clean(request.data?.dentistId || '', 40);
    const config = await loadConfig();
    if (!dentistId || !config.dentists.some((d) => d.id === dentistId)) {
      throw new HttpsError('invalid-argument', 'Selecciona un odontólogo del catálogo para esta cuenta.');
    }
    const already = await dentistUsers(true);
    if (already.some((u) => u.dentistId === dentistId)) {
      throw new HttpsError('already-exists', 'Ese odontólogo ya tiene una cuenta vinculada.');
    }
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email: mail, password, displayName: name });
  } catch (error) {
    if (error.code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'Ya existe una cuenta con ese correo.');
    throw new HttpsError('internal', 'No se pudo crear la cuenta.');
  }

  try {
    await admin.auth().setCustomUserClaims(userRecord.uid, { role });
    await db.doc('users/' + userRecord.uid).set({
      uid: userRecord.uid,
      email: mail,
      name,
      phone: phone(request.data?.phone || '', false),
      role,
      status: 'active',
      patientId: '',
      dentistId,
      preferences: { lang: 'es', theme: 'system', motion: 'system' },
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
      createdBy: auth.uid
    });
    await audit(auth, 'user.create_staff', 'users', userRecord.uid, { meta: { role } });
    return { ok: true, uid: userRecord.uid };
  } catch (error) {
    try { await admin.auth().deleteUser(userRecord.uid); } catch (cleanupError) { logger.error(cleanupError); }
    throw new HttpsError('internal', 'No se pudo crear el perfil del usuario.');
  }
});

exports.syncMyClaims = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request);
  const snap = await db.doc('users/' + auth.uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'La cuenta no tiene perfil de clínica.');
  const profile = snap.data();
  if (profile.status && profile.status !== 'active') {
    throw new HttpsError('permission-denied', 'La cuenta está desactivada.');
  }
  const role = assertRole(profile.role || 'patient');
  await admin.auth().setCustomUserClaims(auth.uid, { role });
  return { ok: true, role, patientId: profile.patientId || '', dentistId: profile.dentistId || '' };
});

/* ------------------------------------------------ administrative records */

exports.adminSavePatient = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception']);
  const id = request.data?.id ? clean(request.data.id, 128, { label: 'paciente' }) : '';
  const fn = clean(request.data?.fn, 80, { min: 1, label: 'nombre' });
  const ln = clean(request.data?.ln, 120, { min: 1, label: 'apellidos' });
  const bd = request.data?.bd ? assertDate(request.data.bd) : '';
  const tel = phone(request.data?.ph || '', false);
  const mail = email(request.data?.em);
  const addr = clean(request.data?.addr || '', 300);
  const status = ['active', 'inactive', 'suspended'].includes(request.data?.status)
    ? request.data.status : 'active';
  const assignedDentistId = clean(request.data?.assignedDentistId || '', 40);
  if (assignedDentistId) {
    const config = await loadConfig();
    if (!config.dentists.some((d) => d.id === assignedDentistId)) {
      throw new HttpsError('invalid-argument', 'El odontólogo asignado no está en el catálogo.');
    }
  }
  const now = Timestamp.now();
  const searchName = `${fn} ${ln} ${mail} ${tel}`.toLowerCase();
  const patientRef = id ? db.doc('patients/' + id) : db.collection('patients').doc();
  const existing = id ? await patientRef.get() : null;
  if (id && (!existing || !existing.exists)) throw new HttpsError('not-found', 'El paciente no existe.');
  const before = existing && existing.exists ? existing.data() : null;

  const data = {
    fn, ln, bd, ph: tel, em: mail, addr,
    assignedDentistId: assignedDentistId || before?.assignedDentistId || '',
    status,
    searchName,
    updatedAt: now,
    updatedBy: auth.uid
  };
  if (!before) {
    data.userId = '';
    data.careTeamIds = assignedDentistId ? [assignedDentistId] : [];
    data.createdAt = now;
    data.createdBy = auth.uid;
  }

  // Vinculación segura: solo con cuentas cuyo correo esté verificado y que no
  // estén ya vinculadas a otra ficha. La identidad sigue siendo responsabilidad
  // del personal que crea/edita la ficha.
  let linkedUid = before?.userId || '';
  if (!linkedUid) {
    const userQuery = await db.collection('users').where('email', '==', mail).limit(1).get();
    if (!userQuery.empty) {
      const userDoc = userQuery.docs[0];
      const user = userDoc.data();
      if (user.role === 'patient' && (!user.patientId || user.patientId === patientRef.id)) {
        try {
          const authUser = await admin.auth().getUser(userDoc.id);
          if (authUser.emailVerified) {
            linkedUid = userDoc.id;
            data.userId = linkedUid;
          }
        } catch (error) {
          logger.warn('No se pudo comprobar la verificación de la cuenta del paciente', error);
        }
      }
    }
  }

  const batch = db.batch();
  batch.set(patientRef, data, { merge: true });
  if (linkedUid && linkedUid !== before?.userId) {
    batch.set(db.doc('users/' + linkedUid), { patientId: patientRef.id, updatedAt: now }, { merge: true });
  }
  batch.set(db.collection('auditLogs').doc(), {
    actorUid: auth.uid, actorRole: auth.role,
    action: before ? 'patient.update' : 'patient.create',
    entity: 'patients', entityId: patientRef.id,
    patientId: patientRef.id, at: now,
    meta: { linkedUserId: linkedUid || '' }
  });
  await batch.commit();

  const saved = await patientRef.get();
  return { ok: true, id: patientRef.id, patient: { id: patientRef.id, ...saved.data() } };
});

exports.adminSavePayment = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception']);
  const patientId = clean(request.data?.patientId, 128, { label: 'paciente' });
  const patientSnap = await db.doc('patients/' + patientId).get();
  if (!patientSnap.exists) throw new HttpsError('not-found', 'Paciente no encontrado.');
  const patient = patientSnap.data();
  const config = await loadConfig();
  const treatmentId = clean(request.data?.treatment || 'revision', 40);
  const treatment = config.treatments.find((t) => t.id === treatmentId);
  const concept = clean(request.data?.concept || treatment?.n || 'Tratamiento', 300, { min: 1, label: 'concepto' });
  const amount = Number(request.data?.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new HttpsError('invalid-argument', 'Importe no válido.');
  }
  const status = ['pending', 'paid', 'refunded', 'void'].includes(request.data?.status)
    ? request.data.status : 'pending';
  const date = request.data?.date ? assertDate(request.data.date) : todayMadrid();
  const invoiceNumber = clean(request.data?.invoiceNumber || '', 80);
  const notes = cleanMultiline(request.data?.notes || '', 2000);
  const now = Timestamp.now();
  const ref = db.collection('payments').doc();
  await ref.set({
    patientId,
    patientName: `${patient.fn || ''} ${patient.ln || ''}`.trim(),
    treatment: treatmentId,
    concept,
    amount,
    status,
    date,
    invoiceNumber,
    notes,
    createdAt: now,
    updatedAt: now,
    createdBy: auth.uid,
    updatedBy: auth.uid,
    ...(status === 'paid' ? { paidAt: now, paidBy: auth.uid } : {})
  });
  await audit(auth, 'payment.create', 'payments', ref.id, { patientId, meta: { amount, status } });
  return { ok: true, id: ref.id };
});

exports.adminUpdatePaymentStatus = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin', 'reception']);
  const id = clean(request.data?.id, 128, { label: 'pago' });
  const status = clean(request.data?.status, 20);
  if (!PAY_STATUS.includes(status)) throw new HttpsError('invalid-argument', 'Estado de pago no válido.');
  const ref = db.doc('payments/' + id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'El pago no existe.');
  const data = snap.data();
  const now = Timestamp.now();
  await ref.update({
    status,
    updatedAt: now,
    updatedBy: auth.uid,
    ...(status === 'paid' ? { paidAt: now, paidBy: auth.uid } : {})
  });
  await audit(auth, 'payment.status', 'payments', id, {
    patientId: data.patientId || '', meta: { status, amount: data.amount || 0 }
  });
  return { ok: true };
});

exports.adminSetUserStatus = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin']);
  const uid = clean(request.data?.uid, 128, { label: 'usuario' });
  const status = clean(request.data?.status, 20);
  if (!['active', 'inactive', 'suspended'].includes(status)) {
    throw new HttpsError('invalid-argument', 'Estado de cuenta no válido.');
  }
  if (uid === auth.uid && status !== 'active') {
    throw new HttpsError('failed-precondition', 'No puedes desactivar tu propia cuenta.');
  }
  const ref = db.doc('users/' + uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'El usuario no existe.');
  const disabled = status !== 'active';
  await admin.auth().updateUser(uid, { disabled });
  if (disabled) await admin.auth().revokeRefreshTokens(uid);
  await ref.update({ status, updatedAt: Timestamp.now(), updatedBy: auth.uid });
  await audit(auth, 'user.status', 'users', uid, { meta: { status } });
  return { ok: true };
});

exports.adminLinkPatientAccount = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin']);
  const patientId = clean(request.data?.patientId, 128, { label: 'paciente' });
  const uid = clean(request.data?.uid, 128, { label: 'usuario' });
  const [patientSnap, userSnap, authUser] = await Promise.all([
    db.doc('patients/' + patientId).get(),
    db.doc('users/' + uid).get(),
    admin.auth().getUser(uid)
  ]);
  if (!patientSnap.exists) throw new HttpsError('not-found', 'La ficha del paciente no existe.');
  if (!userSnap.exists) throw new HttpsError('not-found', 'La cuenta de usuario no existe.');
  if (!authUser.emailVerified) {
    throw new HttpsError('failed-precondition', 'La cuenta debe tener el correo verificado antes de vincularse.');
  }
  const patient = patientSnap.data();
  const user = userSnap.data();
  if (user.role !== 'patient') throw new HttpsError('failed-precondition', 'La cuenta no es de paciente.');
  if (String(patient.em || '').toLowerCase() !== String(authUser.email || '').toLowerCase()) {
    throw new HttpsError('failed-precondition', 'El correo de la ficha y de la cuenta no coinciden.');
  }
  if (patient.userId && patient.userId !== uid) {
    throw new HttpsError('failed-precondition', 'La ficha ya está vinculada a otra cuenta.');
  }
  if (user.patientId && user.patientId !== patientId) {
    throw new HttpsError('failed-precondition', 'La cuenta ya está vinculada a otra ficha.');
  }
  const now = Timestamp.now();
  const batch = db.batch();
  batch.set(db.doc('patients/' + patientId), { userId: uid, updatedAt: now, updatedBy: auth.uid }, { merge: true });
  batch.set(db.doc('users/' + uid), { patientId, updatedAt: now }, { merge: true });
  batch.set(db.collection('auditLogs').doc(), {
    actorUid: auth.uid, actorRole: auth.role, action: 'patient.link_account',
    entity: 'patients', entityId: patientId, patientId, at: now, meta: { uid }
  });
  await batch.commit();
  return { ok: true };
});

/* -------------------------------------------------------- server triggers */

exports.syncConsultationSummary = onDocumentWritten('consultations/{id}', async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;
  const id = event.params.id;
  const summaryRef = db.doc('clinicalSummaries/' + id);

  if (!after || !after.exists) {
    if (before && before.exists) await summaryRef.delete().catch(() => {});
    return;
  }

  const data = after.data();
  const share = data.share === true && String(data.sharedSummary || '').trim().length > 0;
  if (!share) {
    if (before && before.exists && before.data().share === true) {
      await summaryRef.delete().catch(() => {});
    }
    return;
  }

  await summaryRef.set({
    patientId: data.patientId,
    consultationId: id,
    date: data.date,
    treatment: data.treatment,
    dentistId: data.dentistId,
    dentistName: data.dentistName || '',
    summary: String(data.sharedSummary).slice(0, 5000),
    sharedAt: (before && before.exists && before.data().share === true)
      ? (before.data().sharedAt || Timestamp.now())
      : Timestamp.now(),
    updatedAt: Timestamp.now()
  }, { merge: true });

  const beforeShare = before && before.exists && before.data().share === true &&
    before.data().sharedSummary === data.sharedSummary;
  if (!beforeShare) {
    const userId = await patientUserId(data.patientId);
    await notification(userId, {
      type: 'consultation',
      title: 'Nuevo resumen clínico disponible',
      body: 'Tu odontólogo ha compartido el resumen de tu consulta del ' + data.date + '.',
      link: '#paciente-consultas'
    });
    await audit({ uid: data.updatedBy || 'system', role: 'system' }, 'consultation.summary_sync', 'clinicalSummaries', id, {
      patientId: data.patientId
    });
  }
});

exports.notifyAppointment = onDocumentWritten('appointments/{id}', async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;
  if (!after || !after.exists) return;
  const data = after.data();
  const prev = before && before.exists ? before.data() : null;
  const changed = !prev ||
    prev.status !== data.status ||
    prev.date !== data.date ||
    prev.time !== data.time ||
    prev.dentistId !== data.dentistId;
  if (!changed) return;

  const userId = await patientUserId(data.patientId);
  if (!userId) return;

  let title = 'Tu cita ha cambiado';
  let body = `Cita de ${data.treatmentName || data.treatment} el ${data.date} a las ${data.time}.`;
  if (!prev) { title = 'Nueva cita confirmada'; body = `Tienes una cita de ${data.treatmentName || data.treatment} el ${data.date} a las ${data.time} con ${data.dentistName || 'tu odontólogo'}.`; }
  else if (data.status === 'cancelled') { title = 'Cita cancelada'; body = `La cita del ${data.date} a las ${data.time} se ha cancelado.`; }
  else if (data.status === 'done') { title = 'Cita realizada'; body = `Gracias por tu visita del ${data.date}.`; }
  else if (data.status === 'confirmed') { title = 'Cita confirmada'; }

  await notification(userId, { type: 'appointment', title, body, link: '#paciente-citas' });
});

exports.notifyPayment = onDocumentWritten('payments/{id}', async (event) => {
  const before = event.data?.before;
  const after = event.data?.after;
  if (!after || !after.exists) return;
  const data = after.data();
  const prev = before && before.exists ? before.data() : null;
  if (prev && prev.status === data.status) return;
  const userId = await patientUserId(data.patientId);
  if (!userId) return;
  const title = data.status === 'paid' ? 'Pago registrado' : 'Actualización de pago';
  const body = data.status === 'paid'
    ? `Hemos registrado el pago de ${Number(data.amount || 0).toFixed(2)} € (${data.concept || data.treatment || 'tratamiento'}).`
    : `El estado de tu pago es ahora ${data.status}.`;
  await notification(userId, { type: 'payment', title, body, link: '#paciente-pagos' });
});

exports.notifyRequestCreated = onDocumentCreated('requests/{id}', async (event) => {
  const data = event.data?.data();
  if (!data) return;
  try {
    const staff = await db.collection('users')
      .where('role', 'in', ['admin', 'reception'])
      .where('status', '==', 'active')
      .limit(20)
      .get();
    const batch = db.batch();
    for (const doc of staff.docs) {
      batch.set(db.collection('notifications').doc(), {
        userId: doc.id,
        type: 'request',
        title: data.kind === 'booking' ? 'Nueva reserva web' : data.kind === 'change' ? 'Petición de cambio' : 'Nueva solicitud de contacto',
        body: `${data.name || 'Paciente'}${data.date ? ` · ${data.date} ${data.time || ''}` : ''}`,
        link: '#panel-solicitudes',
        read: false,
        createdAt: Timestamp.now()
      });
    }
    batch.set(db.collection('auditLogs').doc(), {
      actorUid: 'system', actorRole: 'system', action: 'request.created',
      entity: 'requests', entityId: event.params.id, at: Timestamp.now(),
      meta: { kind: data.kind, source: data.source || 'web' }
    });
    await batch.commit();
  } catch (error) {
    logger.error('No se pudieron crear las notificaciones de la solicitud', error);
  }
});

exports.notifyMessage = onDocumentCreated('patients/{patientId}/messages/{messageId}', async (event) => {
  const data = event.data?.data();
  if (!data) return;
  try {
    if (data.senderRole === 'patient') {
      const patientSnap = await db.doc('patients/' + event.params.patientId).get();
      const patient = patientSnap.exists ? patientSnap.data() : {};
      const recipients = new Set();
      if (patient.assignedDentistId) {
        const dentistUsers = await db.collection('users')
          .where('role', '==', 'dentist')
          .where('status', '==', 'active')
          .limit(50).get();
        dentistUsers.docs.forEach((d) => {
          const u = d.data();
          if (u.dentistId === patient.assignedDentistId || d.id === patient.assignedDentistId) recipients.add(d.id);
        });
      }
      const staff = await db.collection('users')
        .where('role', '==', 'reception').where('status', '==', 'active').limit(10).get();
      staff.docs.forEach((d) => recipients.add(d.id));
      const batch = db.batch();
      for (const uid of recipients) {
        batch.set(db.collection('notifications').doc(), {
          userId: uid, type: 'message', title: 'Nuevo mensaje de un paciente',
          body: String(data.body || '').slice(0, 300), link: '#panel-paciente-' + event.params.patientId,
          read: false, createdAt: Timestamp.now()
        });
      }
      await batch.commit();
    } else {
      const userId = await patientUserId(event.params.patientId);
      await notification(userId, {
        type: 'message', title: 'Nuevo mensaje de la clínica',
        body: String(data.body || '').slice(0, 300), link: '#paciente'
      });
    }
  } catch (error) {
    logger.error('No se pudo notificar el mensaje', error);
  }
});

/* ---------------------------------------------------------- backups / ops */

async function accessToken() {
  const auth = new GoogleAuth({
    scopes: [
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/datastore'
    ]
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error('No se pudo obtener el token de servicio para la copia.');
  return token.token;
}

async function collectionCounts() {
  const collections = ['users', 'patients', 'appointments', 'consultations', 'clinicalSummaries', 'payments', 'requests', 'documents', 'notifications', 'auditLogs'];
  const out = {};
  await Promise.all(collections.map(async (name) => {
    try {
      const snap = await db.collection(name).count().get();
      out[name] = snap.data().count;
    } catch (error) {
      out[name] = -1;
    }
  }));
  return out;
}

exports.dailyBackup = onSchedule({
  schedule: 'every day 02:30',
  timeZone: 'Europe/Madrid',
  region: REGION,
  timeoutSeconds: 540,
  memory: '512MiB'
}, async () => {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'clinicadental-aurora';
  const bucket = process.env.BACKUP_BUCKET || `${projectId}-backups`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputUriPrefix = `gs://${bucket}/firestore/${stamp}`;
  const manifestRef = db.collection('backups').doc(stamp);
  const counts = await collectionCounts();

  try {
    const token = await accessToken();
    const response = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default):exportDocuments`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outputUriPrefix,
          collectionIds: Object.keys(counts).filter((c) => counts[c] >= 0)
        })
      }
    );
    const body = await response.text();
    if (!response.ok) throw new Error(`Export falló (${response.status}): ${body.slice(0, 500)}`);

    await manifestRef.set({
      type: 'firestore-export',
      projectId,
      bucket,
      outputUriPrefix,
      status: 'completed',
      counts,
      verified: false,
      retentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 35),
      createdAt: Timestamp.now(),
      createdBy: 'scheduled-function',
      apiResponse: JSON.parse(body || '{}')
    });
    logger.info('Copia de Firestore completada', { outputUriPrefix, counts });
  } catch (error) {
    await manifestRef.set({
      type: 'firestore-export',
      projectId,
      bucket,
      outputUriPrefix,
      status: 'failed',
      counts,
      verified: false,
      error: String(error.message || error).slice(0, 1000),
      createdAt: Timestamp.now(),
      createdBy: 'scheduled-function'
    });
    logger.error('Copia de Firestore fallida', error);
    throw error;
  }
});

exports.storageBackup = onSchedule({
  schedule: 'every day 03:00',
  timeZone: 'Europe/Madrid',
  region: REGION,
  timeoutSeconds: 540,
  memory: '512MiB'
}, async () => {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'clinicadental-aurora';
  const sourceBucketName = process.env.STORAGE_BUCKET || `${projectId}.firebasestorage.app`;
  const targetBucketName = process.env.STORAGE_BACKUP_BUCKET || `${projectId}-storage-backups`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const prefix = `storage/${stamp}`;
  const manifestRef = db.collection('backups').doc(stamp + '_storage');

  try {
    const source = admin.storage().bucket(sourceBucketName);
    const target = admin.storage().bucket(targetBucketName);
    const [files] = await source.getFiles({ prefix: 'patients/', autoPaginate: false, maxResults: 5000 });
    let copied = 0;
    let bytes = 0;

    for (const file of files) {
      if (!file.name || file.name.endsWith('/')) continue;
      const destName = `${prefix}/${file.name}`;
      await file.copy(target.file(destName));
      copied += 1;
      bytes += Number(file.metadata?.size || 0);
    }

    await manifestRef.set({
      type: 'storage-copy',
      projectId,
      sourceBucket: sourceBucketName,
      bucket: targetBucketName,
      outputUriPrefix: `gs://${targetBucketName}/${prefix}`,
      status: 'completed',
      objectCount: copied,
      bytes,
      truncated: files.length >= 5000,
      verified: false,
      retentionDays: Number(process.env.BACKUP_RETENTION_DAYS || 35),
      createdAt: Timestamp.now(),
      createdBy: 'scheduled-function'
    });
    logger.info('Copia de Storage completada', { prefix, copied, bytes, truncated: files.length >= 5000 });
  } catch (error) {
    await manifestRef.set({
      type: 'storage-copy',
      projectId,
      sourceBucket: sourceBucketName,
      bucket: targetBucketName,
      outputUriPrefix: `gs://${targetBucketName}/${prefix}`,
      status: 'failed',
      error: String(error.message || error).slice(0, 1000),
      verified: false,
      createdAt: Timestamp.now(),
      createdBy: 'scheduled-function'
    });
    logger.error('Copia de Storage fallida', error);
    throw error;
  }
});

exports.cleanupBackups = onSchedule({
  schedule: 'every day 04:00',
  timeZone: 'Europe/Madrid',
  region: REGION,
  timeoutSeconds: 540,
  memory: '256MiB'
}, async () => {
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 35);
  const cutoff = Timestamp.fromMillis(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const old = await db.collection('backups').where('createdAt', '<', cutoff).limit(50).get();
  let removed = 0;

  for (const doc of old.docs) {
    const data = doc.data();
    const bucketName = String(data.bucket || '');
    const output = String(data.outputUriPrefix || '');
    if (bucketName && output.startsWith(`gs://${bucketName}/`)) {
      const prefix = output.slice(`gs://${bucketName}/`.length);
      try {
        await admin.storage().bucket(bucketName).deleteFiles({ prefix, force: true });
      } catch (error) {
        logger.warn('No se pudieron borrar objetos de copia antiguos', { prefix, error: error.message });
      }
    }
    await doc.ref.delete();
    removed += 1;
  }

  if (removed) {
    await db.collection('auditLogs').add({
      actorUid: 'system', actorRole: 'system', action: 'backup.retention',
      entity: 'backups', entityId: '', at: Timestamp.now(),
      meta: { removed, retentionDays }
    });
  }
  logger.info('Retención de copias aplicada', { removed, retentionDays });
});

exports.verifyBackup = onSchedule({
  schedule: 'every monday 05:00',
  timeZone: 'Europe/Madrid',
  region: REGION,
  timeoutSeconds: 300,
  memory: '256MiB'
}, async () => {
  const latest = await db.collection('backups')
    .where('status', '==', 'completed')
    .orderBy('createdAt', 'desc')
    .limit(1).get();

  if (latest.empty) {
    await db.collection('auditLogs').add({
      actorUid: 'system', actorRole: 'system', action: 'backup.verify_missing',
      entity: 'backups', entityId: '', at: Timestamp.now(), meta: { severity: 'critical' }
    });
    logger.error('No hay ninguna copia completada para verificar.');
    return;
  }

  const doc = latest.docs[0];
  const data = doc.data();
  const bucketName = String(data.bucket || '');
  const outputUriPrefix = String(data.outputUriPrefix || '');
  const prefix = bucketName && outputUriPrefix.startsWith(`gs://${bucketName}/`)
    ? outputUriPrefix.slice(`gs://${bucketName}/`.length)
    : '';

  const fail = async (reason, meta = {}) => {
    await doc.ref.set({ verified: false, verificationError: reason, verifiedAt: Timestamp.now() }, { merge: true });
    await db.collection('auditLogs').add({
      actorUid: 'system', actorRole: 'system', action: 'backup.verify_failed',
      entity: 'backups', entityId: doc.id, at: Timestamp.now(),
      meta: { prefix, reason, ...meta }
    });
    logger.error('Verificación de copia fallida', { backup: doc.id, reason });
  };

  if (!bucketName || !prefix) {
    await fail('El manifiesto no contiene bucket o prefijo válidos.');
    return;
  }

  const ageMs = data.createdAt?.toMillis ? Date.now() - data.createdAt.toMillis() : Infinity;
  if (!Number.isFinite(ageMs) || ageMs > 48 * 60 * 60 * 1000) {
    await fail('La copia más reciente tiene más de 48 horas o no tiene fecha válida.', { ageMs });
    return;
  }

  let files = [];
  try {
    const [objects] = await admin.storage().bucket(bucketName)
      .getFiles({ prefix, maxResults: 20, autoPaginate: false });
    files = objects;
  } catch (error) {
    await fail('No se pudo leer el bucket de copias: ' + String(error.message || error).slice(0, 300));
    return;
  }

  const usable = files.filter((f) => Number(f.metadata?.size || 0) > 0);
  const bytes = usable.reduce((sum, f) => sum + Number(f.metadata?.size || 0), 0);

  if (!usable.length) {
    await fail('No se encontraron objetos con contenido en el destino.', { objects: files.length });
    return;
  }

  await doc.ref.set({
    verified: true,
    verifiedAt: Timestamp.now(),
    verifiedObjects: usable.length,
    verifiedBytes: bytes,
    verificationAgeHours: Math.round(ageMs / (60 * 60 * 1000)),
    verificationError: FieldValue.delete()
  }, { merge: true });
  await db.collection('auditLogs').add({
    actorUid: 'system', actorRole: 'system', action: 'backup.verified',
    entity: 'backups', entityId: doc.id, at: Timestamp.now(),
    meta: { prefix, objects: usable.length, bytes }
  });
});

exports.cleanupExpiredHolds = onSchedule({
  schedule: 'every day 03:15',
  timeZone: 'Europe/Madrid',
  region: REGION,
  timeoutSeconds: 300,
  memory: '256MiB'
}, async () => {
  const now = Timestamp.now();
  const expired = await db.collection('requests')
    .where('status', '==', 'new')
    .where('holdExpiresAt', '<', now)
    .limit(200).get();

  for (const doc of expired.docs) {
    const req = doc.data();
    if (!req.date || !req.dentistId) {
      await doc.ref.update({ status: 'expired', updatedAt: now, updatedBy: 'system' });
      continue;
    }
    const lock = lockRef(req.date, req.dentistId);
    await db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lock);
      const intervals = cleanIntervals(lockSnap.exists ? lockSnap.data().intervals || [] : [])
        .filter((i) => i.requestId !== doc.id);
      tx.set(lock, { date: req.date, dentistId: req.dentistId, intervals, updatedAt: now }, { merge: true });
      tx.update(doc.ref, { status: 'expired', updatedAt: now, updatedBy: 'system' });
    });
  }
  if (!expired.empty) logger.info('Solicitudes caducadas liberadas', { count: expired.size });
});

exports.rebuildScheduleLocks = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  const auth = requireAuth(request, ['admin']);
  const config = await loadConfig(true);
  const byLock = new Map();

  const appts = await db.collection('appointments').get();
  for (const doc of appts.docs) {
    const a = doc.data();
    if (!a.date || !a.dentistId || a.status === 'cancelled') continue;
    const t = config.treatments.find((x) => x.id === a.treatment);
    const dur = t ? t.min : 30;
    const start = t2m(a.time);
    const id = `${a.date}_${a.dentistId}`;
    if (!byLock.has(id)) byLock.set(id, { date: a.date, dentistId: a.dentistId, intervals: [] });
    byLock.get(id).intervals.push({ start, end: start + dur, type: 'appointment', appointmentId: doc.id, patientId: a.patientId, dentistId: a.dentistId });
  }

  const reqs = await db.collection('requests').where('status', '==', 'new').get();
  const nowMs = Date.now();
  for (const doc of reqs.docs) {
    const r = doc.data();
    if (!r.date || !r.dentistId || !r.holdExpiresAt) continue;
    if (r.holdExpiresAt.toMillis && r.holdExpiresAt.toMillis() <= nowMs) continue;
    const t = config.treatments.find((x) => x.id === r.treatment);
    const dur = t ? t.min : 30;
    const start = t2m(r.time);
    const id = `${r.date}_${r.dentistId}`;
    if (!byLock.has(id)) byLock.set(id, { date: r.date, dentistId: r.dentistId, intervals: [] });
    byLock.get(id).intervals.push({ start, end: start + dur, type: 'request', requestId: doc.id, expiresAt: r.holdExpiresAt.toMillis() });
  }

  const existing = await db.collection('scheduleLocks').get();
  const batch = db.batch();
  for (const doc of existing.docs) {
    if (!byLock.has(doc.id)) batch.delete(doc.ref);
  }
  for (const [id, data] of byLock.entries()) {
    batch.set(db.doc('scheduleLocks/' + id), { ...data, updatedAt: Timestamp.now() }, { merge: true });
  }
  await batch.commit();
  await audit(auth, 'scheduleLocks.rebuild', 'scheduleLocks', '', {
    meta: { locks: byLock.size, appointments: appts.size, holds: reqs.size }
  });
  return { ok: true, locks: byLock.size, appointments: appts.size, holds: reqs.size };
});

exports.exportAuditForAdmin = onCall({ cors: true }, async (request) => {
  appCheckGate(request);
  requireAuth(request, ['admin']);
  const from = request.data?.from ? assertDate(request.data.from) : addDays(todayMadrid(), -30);
  const to = request.data?.to ? assertDate(request.data.to) : todayMadrid();
  const snap = await db.collection('auditLogs')
    .where('at', '>=', Timestamp.fromDate(new Date(from + 'T00:00:00Z')))
    .where('at', '<=', Timestamp.fromDate(new Date(to + 'T23:59:59Z')))
    .orderBy('at', 'desc')
    .limit(5000).get();
  return {
    ok: true,
    from,
    to,
    rows: snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        at: x.at?.toDate?.().toISOString() || '',
        actorUid: x.actorUid || '',
        actorRole: x.actorRole || '',
        action: x.action || '',
        entity: x.entity || '',
        entityId: x.entityId || '',
        patientId: x.patientId || '',
        meta: x.meta || {}
      };
    })
  };
});
