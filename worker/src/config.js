export const UPSTREAM_MODEL = "gemini-3.6-flash";

export const UPSTREAM_INTERACTIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/interactions";

export const SYSTEM_INSTRUCTION =
  "Odgovaraj jasno, prirodno i pregledno na srpskom jeziku, osim ako korisnik traži drugi jezik. " +
  "Primarni slučaj su zadaci iz osnovne i srednje škole, naročito osnovne škole. " +
  "Rešenje mora izgledati kao uredno napisano školsko rešenje, ne kao sirov Markdown ili LaTeX. " +
  "FORMATIRANJE MATEMATIKE JE OBAVEZNO: za kratku matematiku unutar rečenice koristi isključivo \\( ... \\), " +
  "a za jednačine i račun u posebnom redu koristi isključivo \\[ ... \\]. " +
  "Nikada ne ostavljaj LaTeX komande kao što su \\frac, \\sqrt, \\cdot, \\times, \\text, \\leq, \\geq, \\begin ili \\end izvan matematičkih delimitera. " +
  "Nikada ne koristi znakove $ ili $$ kao običan tekst oko formule ako možeš da koristiš \\( \\) i \\[ \\]. " +
  "Za osnovnu školu preferiraj jednostavnu notaciju: razlomak, koren, stepen, znak puta, deljenje i obične jednačine; ne koristi egzotične LaTeX makroe bez potrebe. " +
  "Svaki važan korak računanja stavi pregledno u zaseban red, a objašnjenje piši normalnim rečenicama. " +
  "Reči i jedinice unutar formule stavi u \\text{...} ili ih napiši izvan formule. " +
  "Znak procenta unutar formule uvek piši kao \\%, a stepene kao ^{\\circ} ili ih napiši normalno izvan formule. " +
  "Ako koristiš sisteme, matrice, intervale, skupove, trigonometriju, verovatnoću ili geometriju, koristi standardan LaTeX unutar matematičkih delimitera. " +
  "Ne koristi sirov HTML za formatiranje. Ne ostavljaj nezatvorene Markdown oznake, code fence-ove ili matematičke delimitere. " +
  "Markdown koristi samo za korisne naslove, podebljavanje, kurziv, precrtavanje, liste i tabele; nikada ne prikazuj korisniku same Markdown oznake.";

export const PUBLIC_PATH = "/v1/interactions";
export const HEALTH_PATH = "/health";
export const GATEWAY_MARKER_HEADER = "X-Math-Gateway";
export const GATEWAY_MARKER_VALUE = "1";

export const MAX_REQUEST_BYTES = 3 * 1024 * 1024;
export const MAX_TEXT_BYTES = 128 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIOUS_INTERACTION_ID_BYTES = 512;
export const MAX_UPSTREAM_ERROR_BYTES = 64 * 1024;
export const MAX_SYNC_RESPONSE_BYTES = 1024 * 1024;

export const DEFAULT_UPSTREAM_TIMEOUT_MS = 120_000;

export function buildUpstreamBody(publicBody) {
  const thinkingLevel =
    publicBody.generation_settings?.thinking_level ?? "high";
  const codeExecution =
    publicBody.generation_settings?.code_execution ?? true;

  const body = {
    model: UPSTREAM_MODEL,
    input: publicBody.input,
    stream: publicBody.stream,
    store: true,
    system_instruction: SYSTEM_INSTRUCTION,
    generation_config: {
      thinking_level: thinkingLevel,
      thinking_summaries: "auto"
    }
  };

  if (codeExecution) {
    body.tools = [{ type: "code_execution" }];
  }

  if (publicBody.previous_interaction_id) {
    body.previous_interaction_id = publicBody.previous_interaction_id;
  }

  return body;
}
