import { z } from "zod";

/** Validadores de hosts compartidos por la configuración y el alta de servidores. */
export const hostname = z
  .string()
  .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, "debe ser un hostname sin esquema ni ruta");

export const hostOrIp = z
  .string()
  .regex(
    /^((?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}|(\d{1,3}\.){3}\d{1,3})$/i,
    "debe ser un hostname o una IPv4, sin usuario, puerto ni esquema"
  );

export const ipv4 = z.string().regex(/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, "debe ser una IPv4");
