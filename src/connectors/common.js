export const SAMPLE_COL_RE = /(^|_|[a-z])(status|state|type|kind|role|category|level|method|source|currency|channel|stage|priority|gender|tier|mode|provider|unit)$/i;
export const isTextish = (t) => /char|text|enum|string|varchar|nvarchar/i.test(String(t));
