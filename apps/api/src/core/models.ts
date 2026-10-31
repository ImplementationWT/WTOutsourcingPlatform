// Contactos: las personas de los clientes y prospectos, compartidas entre Comercial y Operativa.

export interface ContactDoc {
  _id: string; // uuid
  name: string;
  emails: string[];
  phone: string | null;
  /** Cargo. */
  title: string | null;
  /** Empresa donde trabaja (texto; Empresas ya no es una tabla). */
  company?: string | null;
  linkedinUrl: string | null;
  mondayId?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
