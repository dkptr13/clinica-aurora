# Firebase App Check

## Estado

- Código de inicialización presente en el módulo Firebase (`ReCaptchaEnterpriseProvider`).
- Se activa si existe `window.AURORA_APPCHECK_SITE_KEY` o la meta:

```html
<meta name="aurora-appcheck-site-key" content="SITE_KEY">
```

- En localhost con `?emulator=1` se omite para no interferir con los emuladores.
- En modo directo no hay Functions que validen App Check. La aplicación forzosa se activa en Firebase Console para **Cloud Firestore**.

## Configuración

1. Firebase Console → App Check → app web `Aurora clinica dental`.
2. Registrar proveedor **reCAPTCHA Enterprise**.
3. Crear una clave en Google Cloud → reCAPTCHA Enterprise y añadir los dominios:
   - `clinicadental-aurora.web.app`
   - `clinicadental-aurora.firebaseapp.com`
   - dominios de staging/desarrollo que correspondan.
4. Copiar la site key en la meta del HTML.
5. Desplegar hosting.
6. Comprobar en App Check que llegan solicitudes verificadas desde el dominio real.
7. Cuando todos los clientes envíen token, activar la aplicación forzosa para **Cloud Firestore** en Firebase Console → App Check → Firestore.
8. Probar login, reserva pública y guardados; revisar métricas de App Check.

## Notas

- No se debe activar la aplicación forzosa antes de que la site key funcione en todos los dominios: se bloquearían las escrituras legítimas.
- App Check no sustituye a Authentication ni a las reglas: es una capa antifraude/antibot.
- En Spark no hay Functions ni Storage; solo se puede forzar para Firestore.
- El token se renueva automáticamente (`isTokenAutoRefreshEnabled: true`).
- La CSP ya permite `www.google.com`, `www.recaptcha.net` y `frame-src` de reCAPTCHA.
