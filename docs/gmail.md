# Gmail: correo de cada persona en Comunicaciones

Cada usuario con correo `@whatever.tech` conecta su Gmail desde **Comunicaciones › Conectar Gmail**.
Desde ese momento:

- Los correos de su buzón **con clientes y leads** entran solos a Comunicaciones (en el proyecto o lead que
  corresponda, y en la pestaña Comunicaciones de su detalle). Los demás correos (personales, internos, de
  desconocidos) **no se guardan**.
- Puede **redactar** correos y **responder dentro del hilo** desde la app; salen desde su propia cuenta.
- Cada envío queda auditado (`email.sent`: quién, desde qué cuenta, a quién, qué cliente, hilo y mensaje).
- Al escribir un destinatario se sugieren correos: a quién ya le escribió (su propio buzón en la app),
  contactos y leads (si ve Comercial) y la gente de la app (también por usuario: «manu» →
  manuel@whatever.tech). `GET /api/me/mail/recipients?q=`.
- Los correos salen con su **firma de Gmail** (Configuración › Firma de su cuenta). El servidor la lee
  con `gmail.readonly` (`settings/sendAs`, sin scopes nuevos), la guarda 10 minutos en memoria y la
  agrega como HTML + texto. Al redactar se ve en texto y se puede quitar para ese correo.
- La tarjeta de Gmail muestra un spinner mientras el servidor sincroniza (al conectar, por push o
  cada 5 minutos) y recarga los correos al terminar.

## Cómo funciona (delegación de dominio sin llave)

La política de la empresa no permite llaves de Service Account, así que el backend no firma nada él mismo:

```text
Cuenta de Google del backend (ADC)          ← credencial base: GOOGLE_BASE_CREDENTIAL
   │  rol Service Account Token Creator sobre la SA
   ▼
IAM Credentials · signJwt                  ← Google firma un JWT de la SA con sub = caleb@whatever.tech
   ▼
oauth2.googleapis.com/token (jwt-bearer)   ← delegación de dominio (Workspace Admin)
   ▼
Access token que actúa como caleb@whatever.tech (gmail.readonly + gmail.send), 1 hora, en memoria
```

Código: `apps/api/src/mail/` (google.ts: cadena de tokens y Gmail REST; matching.ts: reglas de cliente;
service.ts: sincronización y envío) y `apps/api/src/routes/mail.ts`.

### Aislamiento

- Todas las rutas son `/api/me/mail/…`: el buzón es **siempre** el correo del usuario autenticado
  (de Usuarios), nunca un parámetro. No existe ninguna ruta que reciba un `userId` o un buzón.
- Solo se responde en hilos del **propio** buzón. Un correo sincronizado lo ven el dueño y quienes ven
  ese proyecto o lead (las mismas reglas que las comunicaciones manuales).
- Un correo de Gmail no se edita en la app (solo se le pone seguimiento o se quita de la app).
- Los tokens nunca salen del backend ni se guardan en la base.

### Asociación con el cliente (scope §11)

1. Correo exacto de un contacto o del lead en From, To o Cc → su proyecto (o su lead; un lead ganado
   cuenta como su proyecto). Si el hilo ya estaba en uno de los candidatos, se respeta.
2. Hilo ya asociado (otro mensaje del mismo hilo en el mismo buzón).
3. Dominio, solo si apunta a **un único** cliente y no es un correo gratuito (gmail.com, outlook.com…).

Sin coincidencia, el correo no entra. Cada correo muestra por qué regla se asoció.

### Sincronización

- **Push** (si hay tópico): Gmail `watch` → Pub/Sub → `POST /api/mail/gmail/push?key=…` → historial
  incremental (`historyId`). El watch se renueva solo antes de vencer (dura 7 días).
- **Recuperación**: cada 5 minutos se sincronizan todos los buzones conectados (avisos perdidos,
  reinicios). Si el `historyId` venció, se recargan los últimos 7 días. Un mensaje nunca entra dos veces
  (índice único por buzón y mensaje).
- Al conectar se cargan los últimos 14 días.

## Configuración (una vez)

### 1. Credencial base del backend

La identidad con **Service Account Token Creator** sobre la SA es una cuenta de Google. Recomendado: una
cuenta dedicada (p. ej. `integraciones@whatever.tech`), no la de una persona (si esa cuenta se suspende,
Gmail deja de sincronizar para todos).

En una máquina con `gcloud`:

```bash
gcloud auth application-default login --account=integraciones@whatever.tech
cat ~/.config/gcloud/application_default_credentials.json   # → secreto GOOGLE_BASE_CREDENTIAL
```

> **Reautenticación de Google Cloud:** si Workspace tiene activo *Seguridad › Control de acceso y datos ›
> Control de sesión de Google Cloud* con reautenticación periódica, esta credencial vence cada N horas y
> Gmail se cae. Pon la cuenta del backend en una unidad organizativa con **"Nunca requerir
> reautenticación"**. Si vence, la tarjeta de Gmail de cada usuario lo dice y basta con regenerarla.

### 2. GitHub (Settings › Secrets and variables › Actions)

| Tipo | Nombre | Valor |
| --- | --- | --- |
| Secret | `GOOGLE_BASE_CREDENTIAL` | El JSON del paso 1 |
| Variable | `GMAIL_SERVICE_ACCOUNT` | Correo de la SA (`…@<proyecto>.iam.gserviceaccount.com`) |
| Variable (opcional) | `GMAIL_DOMAIN` | `whatever.tech` (por defecto) |
| Variable (opcional) | `GMAIL_PUBSUB_TOPIC` | `projects/<proyecto>/topics/gmail-push` (paso 4) |
| Secret (opcional) | `GMAIL_PUSH_SECRET` | `openssl rand -hex 24` (paso 4) |

Sin `GOOGLE_BASE_CREDENTIAL` o sin `GMAIL_SERVICE_ACCOUNT`, Gmail queda desactivado y el resto de la app
funciona igual.

### 3. Delegación de dominio (Workspace Admin)

*Seguridad › Controles de API › Delegación de todo el dominio*: el **Client ID** de la SA con exactamente:

```text
https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send
```

Sin `gmail.modify`: la app nunca borra, mueve ni marca correos.

### 4. Push con Pub/Sub (opcional, recomendado)

Sin esto, los correos llegan con hasta 5 minutos de retraso.

```bash
gcloud pubsub topics create gmail-push
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher
gcloud pubsub subscriptions create gmail-push-launchpad --topic=gmail-push --ack-deadline=30 \
  --push-endpoint="https://launchpad.whatever.tech/api/mail/gmail/push?key=<GMAIL_PUSH_SECRET>"
```

> Si la política *Domain restricted sharing* (`iam.allowedPolicyMemberDomains`) impide dar el rol a
> `gmail-api-push@system.gserviceaccount.com`, se necesita una excepción para ese tópico; mientras tanto
> funciona por sondeo.

### 5. Desplegar y conectar

1. Volver a correr el workflow **Deploy** (los secretos solo se leen al desplegar).
2. Cada persona debe tener su correo `@whatever.tech` en **Usuarios**.
3. Cada persona entra a **Comunicaciones › Conectar Gmail**.

### Probar en local

```bash
cd apps/api
GMAIL_SERVICE_ACCOUNT=<sa>@<proyecto>.iam.gserviceaccount.com \
GOOGLE_BASE_CREDENTIAL_PATH=$HOME/.config/gcloud/application_default_credentials.json \
pnpm -s dev:demo     # panel: pnpm dev:web → http://localhost:5173
```

Tu usuario de la demo debe tener tu correo `@whatever.tech` (Usuarios › editar).

## Errores que muestra la tarjeta de Gmail

| Mensaje | Causa |
| --- | --- |
| La cuenta de Google del backend no pudo autenticarse | La credencial base venció o se revocó (paso 1) |
| La cuenta del backend no puede firmar como la Service Account | Falta el rol Token Creator o la API IAM Service Account Credentials |
| Workspace no autoriza la delegación | Client ID o scopes del paso 3 |
| No se pudo actuar como … | La cuenta no existe en Workspace, está suspendida o no tiene Gmail |

## Pendiente (siguientes fases)

- Asociar un correo a un **Deal** concreto (el campo `dealId` ya existe; hoy queda en el proyecto o lead).
- Reasignar a mano un correo mal asociado.
- Política de retención (cuánto tiempo se guardan los correos) y adjuntos.
