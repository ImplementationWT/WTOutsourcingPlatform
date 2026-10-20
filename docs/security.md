# Seguridad: credenciales de clientes

Cómo maneja la plataforma las credenciales que un operador introduce para un cliente
(hoy, el token de Monday.com de la integración opcional del template 1.4.0).

## Recorrido de una credencial

1. **Navegador.** Vive solo en el estado del formulario: nunca en `localStorage`,
   `sessionStorage`, la URL, la caché de consultas ni los logs del navegador. Los
   campos son `type=password` con *mostrar/ocultar* y `autocomplete="off"`. Se borra
   del formulario al enviarla o al salir.
2. **Petición.** Viaja una vez, por HTTPS, a `POST /api/clients` (alta) o
   `PUT /api/clients/:id/integrations/:provider` (actualización). Al recibirla se
   registra para redacción: si apareciera en un error o log, se sustituye por
   `[REDACTED]`. Los errores 4xx se registran solo con su código (un JSON mal formado
   podría citar el cuerpo) y ninguna respuesta devuelve el cuerpo recibido.
3. **Validación.** "Probar conexión" y el PUT la comprueban contra el host fijo del
   catálogo (`https://api.monday.com/v2`), con timeout de 10 s y sin seguir
   redirecciones. Ningún host o URL procede del navegador. El resultado es `ok` o un
   código genérico (`auth_failed`, `timeout`, `unavailable`), nunca el mensaje del
   proveedor.
4. **Tránsito cifrado.** Mientras se aprovisiona se guarda en `provisioning_secrets`
   cifrada con **AES-256-GCM** y la clave del servidor; el AAD es `clientId:provider`,
   así que un texto cifrado no se puede mover a otro cliente ni a otro proveedor. Nunca
   hay texto plano en la base.
5. **Destino.** La etapa `github_secrets` (o el trabajo de integración) la escribe como
   secret del entorno `production` del repo del cliente (`MONDAY_API_TOKEN`), cifrada
   con la clave pública del entorno, y **borra el documento transitorio** en ese mismo
   momento.
6. **Servidor.** El workflow del template la envía a `deploy-client`, que solo acepta
   las 6 variables del contrato y la escribe en el `.env` 0600 del cliente.

En el cliente de la base administrativa solo se guarda `{ enabled, requestedAt,
configuredAt, updatedAt }`. El panel muestra estado y fechas: nunca valores, ni
parciales, ni longitudes. La auditoría (`integration_enabled`, `integration_updated`,
`integration_removed`, `integration_validated`, `integration_credential_stored`) solo
lleva el proveedor y los nombres de las variables.

## TTL

Los documentos de `provisioning_secrets` caducan a las **24 h**
(`INTEGRATION_SECRET_TTL_HOURS`, 1–168) mediante un índice TTL de MongoDB; las lecturas
comprueban además `expiresAt`, porque el TTL tarda hasta ~60 s. Si un trabajo queda
detenido más que eso, `github_secrets` falla con `integration_credential_expired` y
pide volver a introducir la credencial desde el detalle del cliente
(Integraciones → Actualizar credencial); después se reintenta el trabajo.

## Clave de cifrado

`INTEGRATION_ENCRYPTION_KEY_SECRET_REF` es la **ruta** a un archivo con 32 bytes en
base64, no el valor. En producción la genera `deploy/activate.sh` una sola vez en
`/opt/wt-launchpad/integration.key` (root, 0400 para el uid del contenedor), nunca
sale del VPS y se monta de solo lectura en `/run/secrets/integration.key`. Sin la clave,
la plataforma rechaza activar integraciones (503) y el resto sigue funcionando.

## Claves de los servidores de despliegue

`SERVER_KEYS_ENCRYPTION_KEY_SECRET_REF` apunta a `/opt/wt-launchpad/server-keys.key`, que
genera `deploy/activate.sh` igual que la anterior y se monta en `/run/secrets/server-keys.key`.
Cifra la clave privada del provisioner de cada servidor dado de alta desde el panel (las genera
Launchpad; nunca se muestran ni se registran). Detalles, huella fijada y rotación en
[servers.md](servers.md).

## Rotación

- **Clave de cifrado:** solo afecta a credenciales en tránsito (minutos). En el VPS:
  `rm /opt/wt-launchpad/integration.key` y redesplegar la plataforma; las credenciales
  pendientes cifradas con la clave anterior dejan de poder leerse y el trabajo afectado
  pedirá introducirlas de nuevo.
- **Credencial de un cliente:** desde el detalle del cliente → Integraciones →
  *Actualizar credencial*. Con el cliente listo se escribe el secret y se redespliega;
  ver [runbooks.md](runbooks.md#rotar-la-credencial-de-integración-de-un-cliente).
- **Quitar una integración:** *Desactivar* borra el secret del repo y redespliega para
  que la variable desaparezca del contenedor.
