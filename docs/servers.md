# Servidores de despliegue

Cada proyecto se despliega en **un servidor**, que se elige al crearlo y no cambia
nunca. Los servidores se gestionan en **Integraciones → Servidores**. Cada uno tiene
su propio dominio de apps (`https://<proyecto>.<dominio>`) con un registro DNS
comodín `*.<dominio>` → IP del servidor.

El servidor de la configuración de la plataforma (`DEPLOY_HOST`, `DEPLOY_HOST_KEY`,
la clave del provisioner y `APP_BASE_DOMAIN`) aparece como **Principal**. Los
proyectos anteriores a los servidores múltiples están en él, y se edita como siempre,
en el despliegue de la plataforma.

## Modelo de seguridad

- **Launchpad nunca tiene acceso root.** Cada VPS se prepara una vez a mano con
  `bootstrap-vps.sh`. Launchpad entra como `provisioner`, con comando forzado
  (`provisioner-dispatch`), y solo puede ejecutar con `sudo` los scripts de
  `/opt/platform/bin`. Los repos despliegan como `deploy`, con una clave por cliente.
- **No se piden contraseñas ni claves.** Al dar de alta un servidor, Launchpad genera
  un par ed25519 **exclusivo de ese servidor**:
  - El panel solo muestra la clave pública, para instalarla en el VPS.
  - La privada se guarda cifrada (AES-256-GCM, ligada al id del servidor) con
    `server-keys.key`, que nunca sale del VPS de la plataforma.
  - Ninguna respuesta de la API ni ningún log la contiene.
  - Si se compromete un servidor, los demás no quedan expuestos.
- **Huella fijada, sin confiar a ciegas.**
  - Fijación: la clave del host solo se fija si su huella coincide con la que la
    persona pega desde la **consola del proveedor** (`ssh-keygen -lf`).
  - Después: cualquier otra clave se rechaza (posible suplantación).
  - Con proyectos: la huella de un servidor que ya los tiene no se puede cambiar.
- **Solo servidores verificados.**
  - Al crear un proyecto solo se pueden elegir servidores que hayan pasado *Verificar*.
  - *Verificar* ejecuta `server-info` por la conexión fijada y comprueba el DNS comodín.
- **Permisos y auditoría.** Solo administradores. Alta, huella, verificación, rotación
  y baja quedan en la auditoría.

## Añadir un servidor

1. **DNS:** crea el registro `A *.<dominio>` → IP pública del VPS.
2. **VPS:** necesita Docker, nginx y certbot instalados (como el principal).
3. **Panel:** en **Integraciones → Servidores → Añadir servidor**, rellena nombre,
   host SSH, puerto, dominio de apps e IP pública.
4. **Preparar el VPS:** el panel muestra los comandos exactos:
   - copiar los scripts con `rsync`;
   - escribir `/opt/platform/etc/platform.conf` (`GHCR_ORG`, `APP_BASE_DOMAIN`,
     `ACME_EMAIL`, `PANEL_ORIGIN` y `PANEL_UPSTREAM=https://<panel>`);
   - instalar la clave pública con
     `bootstrap-vps.sh --wire-nginx --provisioner-pubkey …`.
5. **Confirmar la huella:** en la consola del VPS ejecuta
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` y pega la salida.
6. **Verificar:** si todo sale en verde, el servidor aparece al crear proyectos.

### Qué comprueba *Verificar*

| Comprobación | Bloquea | Arreglo |
| --- | --- | --- |
| Conexión SSH con la clave y la huella | Sí | Paso 4 (clave) o 5 (huella) |
| Scripts versión ≥ 2 | Sí | Repetir el `rsync` y `bootstrap-vps.sh` |
| `APP_BASE_DOMAIN` igual al del panel | Sí | Corregir `platform.conf` |
| `GHCR_ORG` igual al de la plataforma | Sí | Corregir `platform.conf` |
| `ACME_EMAIL`, nginx con el include, Docker, certbot | Sí | `platform.conf` / `bootstrap-vps.sh --wire-nginx` |
| Puertos libres | Sí | Ampliar `PORT_RANGE_*` |
| DNS comodín → IP pública | Sí | Registro `A *.<dominio>` |
| Disco (≥ 2 GB) | No | Liberar espacio |
| Vistas previas (`PANEL_ORIGIN`, `PANEL_UPSTREAM` https) | No | `platform.conf` |

## Vistas previas del AI Developer

Se levantan en el servidor del proyecto. En un servidor sin Launchpad, nginx valida
cada visita contra el panel por HTTPS (`PANEL_UPSTREAM=https://<panel>`). Esas rutas
validan un pase firmado y ligado al host exacto.

## Rotación y pérdida de claves

- **Rotar clave** (en la tarjeta del servidor): genera un par nuevo. Repite el paso 3
  de los comandos (instalar la nueva pública con `bootstrap-vps.sh
  --provisioner-pubkey`, que reemplaza la anterior) y vuelve a verificar.
- **Si se pierde `/opt/wt-launchpad/server-keys.key`:** el siguiente despliegue crea
  una nueva y las claves guardadas dejan de poder descifrarse. Rota la clave de cada
  servidor e instálala de nuevo en su VPS.
- **Quitar un servidor:** solo sin proyectos, y escribiendo su dominio para confirmar.
  En el VPS, borra la línea `platform-provisioner` de
  `~provisioner/.ssh/authorized_keys`.
