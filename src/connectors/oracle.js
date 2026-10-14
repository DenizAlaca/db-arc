import { SAMPLE_COL_RE } from './common.js';

export function parseOracleUrl(url) {
  const u = new URL(String(url).replace(/^oracle:/i, 'http:'));
  return {
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    connectString: `${u.hostname}:${u.port || 1521}/${decodeURIComponent(u.pathname.slice(1)) || 'FREEPDB1'}`,
    schema: u.searchParams.get('schema') || null,
  };
}

const oraType = (c) => {
  const t = c.DATA_TYPE;
  if (/CHAR/.test(t)) return `${t}(${c.CHAR_LENGTH || c.DATA_LENGTH})`;
  if (t === 'NUMBER' && c.DATA_PRECISION != null) return c.DATA_SCALE ? `NUMBER(${c.DATA_PRECISION},${c.DATA_SCALE})` : `NUMBER(${c.DATA_PRECISION})`;
  return t;
};

export async function introspect({ url, config, samples = true }) {
  const { default: oracledb } = await import('oracledb').catch(() => { throw new Error('Oracle için "oracledb" paketi gerekli: npm i oracledb'); });
  const cfg = config ?? parseOracleUrl(url);
  const conn = await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString: cfg.connectString });
  conn.callTimeout = 15000;
  const q = async (sql, binds = {}) => (await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows;
  const id = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  try {
    const owner = (cfg.schema || (await q(`SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') AS S FROM DUAL`))[0].S).toUpperCase();
    const rels = await q(`SELECT TABLE_NAME AS NAME, 'table' AS KIND, NUM_ROWS FROM ALL_TABLES WHERE OWNER=:o AND NESTED='NO' AND SECONDARY='N' AND TABLE_NAME NOT LIKE 'BIN$%' AND TABLE_NAME NOT LIKE 'DR$%'
      UNION ALL SELECT VIEW_NAME, 'view', NULL FROM ALL_VIEWS WHERE OWNER=:o ORDER BY 1`, { o: owner });
    const cols = await q(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, CHAR_LENGTH, DATA_PRECISION, DATA_SCALE, NULLABLE FROM ALL_TAB_COLUMNS WHERE OWNER=:o ORDER BY TABLE_NAME, COLUMN_ID`, { o: owner });
    const cons = await q(`SELECT c.TABLE_NAME, c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, cc.COLUMN_NAME, cc.POSITION, r.OWNER AS R_OWNER, r.TABLE_NAME AS R_TABLE, rc.COLUMN_NAME AS R_COLUMN
      FROM ALL_CONSTRAINTS c JOIN ALL_CONS_COLUMNS cc ON cc.OWNER=c.OWNER AND cc.CONSTRAINT_NAME=c.CONSTRAINT_NAME
      LEFT JOIN ALL_CONSTRAINTS r ON r.OWNER=c.R_OWNER AND r.CONSTRAINT_NAME=c.R_CONSTRAINT_NAME
      LEFT JOIN ALL_CONS_COLUMNS rc ON rc.OWNER=r.OWNER AND rc.CONSTRAINT_NAME=r.CONSTRAINT_NAME AND rc.POSITION=cc.POSITION
      WHERE c.OWNER=:o AND c.CONSTRAINT_TYPE IN ('P','R') ORDER BY c.TABLE_NAME, c.CONSTRAINT_NAME, cc.POSITION`, { o: owner });
    const byName = new Map();
    for (const r of rels) byName.set(r.NAME, { name: r.NAME, kind: r.KIND, columns: [], pk: [], fks: [], rows: r.NUM_ROWS == null ? null : Number(r.NUM_ROWS), samples: {} });
    for (const c of cols) {
      const t = byName.get(c.TABLE_NAME); if (!t) continue;
      t.columns.push({ name: c.COLUMN_NAME, type: oraType(c), nullable: c.NULLABLE === 'Y', pk: false });
    }
    const fkMap = new Map();
    for (const c of cons) {
      const t = byName.get(c.TABLE_NAME); if (!t) continue;
      if (c.CONSTRAINT_TYPE === 'P') { t.pk.push(c.COLUMN_NAME); const col = t.columns.find((x) => x.name === c.COLUMN_NAME); if (col) col.pk = true; continue; }
      const key = `${c.TABLE_NAME}\0${c.CONSTRAINT_NAME}`;
      if (!fkMap.has(key)) { const fk = { columns: [], refTable: c.R_OWNER && c.R_OWNER !== owner ? `${c.R_OWNER}.${c.R_TABLE}` : c.R_TABLE, refColumns: [] }; fkMap.set(key, fk); t.fks.push(fk); }
      const fk = fkMap.get(key); fk.columns.push(c.COLUMN_NAME); if (c.R_COLUMN) fk.refColumns.push(c.R_COLUMN);
    }
    const tables = [...byName.values()];
    for (const t of tables) {
      if (t.kind !== 'table' || t.rows != null) continue;
      try { t.rows = Number((await q(`SELECT COUNT(*) AS N FROM (SELECT 1 FROM ${id(owner)}.${id(t.name)} WHERE ROWNUM <= 100001)`))[0].N); } catch {}
    }
    if (samples) {
      for (const t of tables) {
        if (t.kind !== 'table' || !t.rows || t.rows > 2_000_000) continue;
        for (const c of t.columns) {
          if (c.pk || !SAMPLE_COL_RE.test(c.name) || !/CHAR/.test(c.type)) continue;
          try {
            const vals = await q(`SELECT ${id(c.name)} AS V FROM ${id(owner)}.${id(t.name)} WHERE ${id(c.name)} IS NOT NULL GROUP BY ${id(c.name)} ORDER BY COUNT(*) DESC FETCH FIRST 9 ROWS ONLY`);
            if (vals.length && vals.length < 9) t.samples[c.name] = vals.map((r) => r.V);
          } catch {}
        }
      }
    }
    return { dialect: 'oracle', database: `${owner}@${cfg.connectString}`, tables };
  } finally {
    await conn.close().catch(() => {});
  }
}
