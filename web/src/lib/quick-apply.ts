import { companySlug } from "./company-slug.mjs";

export interface QuickApplyInput {
  url: string;
  title?: string | null;
  company?: string | null;
  role?: string | null;
  via?: string | null;
  notes?: string | null;
}

export interface ParsedQuickApply {
  url: string;
  company: string;
  role: string;
  via: string;
  notes: string;
}

const ATS_BRAND_SUFFIX_RE =
  /\s*[|–—-]\s*(?:Greenhouse|Lever|Ashby|Workday|Workable|SmartRecruiters|iCIMS|Jobvite|Careers|Jobs|Job Board)\s*$/i;

const JOB_TITLE_KEYWORDS = new Set([
  "engineer",
  "developer",
  "manager",
  "lead",
  "director",
  "designer",
  "specialist",
  "analyst",
  "architect",
  "vp",
  "intern",
  "consultant",
  "associate",
  "scientist",
  "researcher",
  "product",
  "executive",
  "officer",
  "staff",
  "senior",
  "junior",
  "head",
  "administrator",
  "coordinator",
  "recruiter",
  "writer",
  "representative",
  "technician",
  "expert",
  "strategist",
  "producer",
  "counsel",
]);

function hasJobKeyword(text: string): boolean {
  const words = text.toLowerCase().split(/[\s,/-]+/);
  return words.some((w) => JOB_TITLE_KEYWORDS.has(w));
}

export function formatWord(str: string): string {
  if (!str) return "";
  return str
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function cleanDomain(hostname: string): string {
  let host = (hostname || "").toLowerCase().trim();
  host = host.replace(/^(?:www|careers|jobs|boards|apply|job-boards)\./i, "");
  const parts = host.split(".");
  if (parts.length === 0 || !parts[0]) return "Unknown";
  const name = parts[0];
  return formatWord(name) || "Unknown";
}

export function extractCompanyFromUrl(rawUrl: string | URL): string | null {
  let parsed: URL;
  try {
    parsed = typeof rawUrl === "string" ? new URL(rawUrl) : rawUrl;
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split("/").filter(Boolean);

  // Greenhouse: boards.greenhouse.io/{company}/jobs/... or job-boards.greenhouse.io/{company}/jobs/...
  if (
    host === "boards.greenhouse.io" ||
    host === "job-boards.greenhouse.io" ||
    host.endsWith(".greenhouse.io")
  ) {
    if (segments.length > 0) return segments[0];
  }

  // Lever: jobs.lever.co/{company}/...
  if (host === "jobs.lever.co" || host.endsWith(".lever.co")) {
    if (segments.length > 0) return segments[0];
  }

  // Ashby: jobs.ashbyhq.com/{company}/...
  if (host === "jobs.ashbyhq.com" || host.endsWith(".ashbyhq.com")) {
    if (segments.length > 0) return segments[0];
  }

  // Workday: {company}.wd*.myworkdayjobs.com/... or ...myworkdayjobs.com/.../{company}/...
  if (host.includes("myworkdayjobs.com")) {
    const m = host.match(/^([a-z0-9_-]+)(?:\.wd\d+)?\.myworkdayjobs\.com$/);
    if (m && m[1] && !/^wd\d+$/.test(m[1]) && m[1] !== "www") {
      return m[1];
    }
    if (segments.length > 0) {
      if (/^[a-z]{2}(?:-[a-z]{2,4})?$/i.test(segments[0])) {
        if (segments.length > 1) return segments[1];
      } else {
        return segments[0];
      }
    }
  }

  return null;
}

export function parseTitle(
  title: string,
  knownCompanySlug?: string | null,
): { role?: string; company?: string } {
  let cleaned = (title || "").trim();
  if (!cleaned) return {};

  while (ATS_BRAND_SUFFIX_RE.test(cleaned)) {
    cleaned = cleaned.replace(ATS_BRAND_SUFFIX_RE, "").trim();
  }

  const atMatch = cleaned.match(/^(.*?)\s+(?:at|@)\s+(.*?)$/i);
  if (atMatch) {
    const rolePart = atMatch[1].trim();
    const companyPart = atMatch[2].trim();
    if (rolePart && companyPart) {
      return { role: rolePart, company: companyPart };
    }
  }

  const parts = cleaned.split(/\s*[-|–—]\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 2) {
    const [part0, part1] = parts;
    if (knownCompanySlug) {
      const slug0 = companySlug(part0)?.slug;
      const slug1 = companySlug(part1)?.slug;
      if (slug1 === knownCompanySlug) {
        return { role: part0, company: part1 };
      }
      if (slug0 === knownCompanySlug) {
        return { role: part1, company: part0 };
      }
    }
    const p0HasJob = hasJobKeyword(part0);
    const p1HasJob = hasJobKeyword(part1);
    if (p0HasJob && !p1HasJob) {
      return { role: part0, company: part1 };
    }
    if (!p0HasJob && p1HasJob) {
      return { role: part1, company: part0 };
    }
    return { role: part0, company: part1 };
  } else if (parts.length > 2) {
    if (knownCompanySlug) {
      const lastSlug = companySlug(parts[parts.length - 1])?.slug;
      if (lastSlug === knownCompanySlug) {
        return {
          role: parts.slice(0, -1).join(" - "),
          company: parts[parts.length - 1],
        };
      }
      const firstSlug = companySlug(parts[0])?.slug;
      if (firstSlug === knownCompanySlug) {
        return {
          role: parts.slice(1).join(" - "),
          company: parts[0],
        };
      }
    }
    return {
      role: parts.slice(0, -1).join(" - "),
      company: parts[parts.length - 1],
    };
  } else if (parts.length === 1) {
    return { role: parts[0] };
  }

  return {};
}

export function parseQuickApply(input: QuickApplyInput): ParsedQuickApply {
  if (!input || !input.url || typeof input.url !== "string") {
    throw new Error("Missing or invalid url");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.url.trim());
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error("Missing or invalid url");
    }
  } catch {
    throw new Error("Missing or invalid url");
  }

  const atsCompany = extractCompanyFromUrl(parsedUrl);
  const knownSlug = atsCompany ? companySlug(atsCompany)?.slug : null;

  let titleCompany: string | undefined;
  let titleRole: string | undefined;

  if (input.title && typeof input.title === "string" && input.title.trim()) {
    const parsedTitle = parseTitle(input.title, knownSlug);
    titleCompany = parsedTitle.company;
    titleRole = parsedTitle.role;
  }

  const cleanField = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim();

  let company = "";
  if (input.company && typeof input.company === "string" && input.company.trim()) {
    company = cleanField(input.company);
  } else if (titleCompany) {
    company = cleanField(titleCompany);
  } else if (atsCompany) {
    company = formatWord(atsCompany);
  } else {
    company = cleanDomain(parsedUrl.hostname);
  }
  if (!company) company = "Unknown";

  let role = "";
  if (input.role && typeof input.role === "string" && input.role.trim()) {
    role = cleanField(input.role);
  } else if (titleRole) {
    role = cleanField(titleRole);
  } else {
    role = "Unknown Role";
  }

  const via =
    input.via && typeof input.via === "string" && input.via.trim()
      ? cleanField(input.via)
      : "Direct";

  const notes =
    input.notes && typeof input.notes === "string" && input.notes.trim()
      ? cleanField(input.notes)
      : "Applied via Quick Apply";

  return {
    url: parsedUrl.href,
    company,
    role,
    via,
    notes,
  };
}

export function localToday(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function buildTrackerTsv(item: ParsedQuickApply, dateStr?: string) {
  const date = dateStr || localToday();
  const header =
    "#\tDate\tCompany\tRole\tVia\tStatus\tScore\tReport\tPDF\tNotes\tURL";
  const row = `—\t${date}\t${item.company}\t${item.role}\t${item.via}\tApplied\t—\t—\t❌\t${item.notes}\t${item.url}`;
  return {
    tsvHeader: header,
    tsvRow: row,
    fullTsv: `${header}\n${row}\n`,
  };
}
