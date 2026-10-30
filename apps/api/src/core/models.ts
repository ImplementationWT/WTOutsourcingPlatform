// Núcleo compartido entre Comercial y Operativa: Empresas y Contactos (docs/rework-plataforma.md §4.1).

export const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"] as const;
export type CompanySize = (typeof COMPANY_SIZES)[number];

export interface CompanyDoc {
  _id: string; // uuid
  name: string;
  domain: string | null;
  industry: string | null;
  size: CompanySize | null;
  /** País o ubicación, texto libre. */
  location: string | null;
  mondayId?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactDoc {
  _id: string; // uuid
  name: string;
  emails: string[];
  phone: string | null;
  /** Cargo. */
  title: string | null;
  linkedinUrl: string | null;
  companyId: string | null;
  mondayId?: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}
