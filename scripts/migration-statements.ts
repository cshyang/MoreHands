/** Split repository migrations without breaking trigger bodies or quoted semicolons. */
export function migrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '', quote = '', token = '', depth = 0, trigger = false;
  const finishToken = () => {
    if (!token) return;
    const word = token.toUpperCase();
    if (/^\s*CREATE\s+TRIGGER\b/i.test(current)) trigger = true;
    if (trigger && (word === 'BEGIN' || word === 'CASE')) depth++;
    if (trigger && word === 'END') depth--;
    token = '';
  };
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index], next = sql[index + 1];
    if (quote) {
      current += char;
      if (char === quote) {
        if (next === quote) { current += next; index++; }
        else quote = '';
      }
      continue;
    }
    if (char === '-' && next === '-') {
      finishToken(); while (index < sql.length && sql[index] !== '\n') index++;
      current += '\n'; continue;
    }
    if (char === '/' && next === '*') {
      finishToken(); index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index++;
      if (index >= sql.length) throw new Error('Unterminated migration comment');
      index++; current += ' '; continue;
    }
    if (char === "'" || char === '"' || char === '`') { finishToken(); quote = char; current += char; continue; }
    if (/[A-Za-z_]/.test(char)) { token += char; current += char; continue; }
    finishToken();
    if (char === ';' && (!trigger || depth === 0)) {
      if (current.trim()) statements.push(current.trim());
      current = ''; depth = 0; trigger = false;
    } else current += char;
  }
  finishToken();
  if (quote || depth !== 0) throw new Error('Incomplete migration statement');
  if (current.trim()) statements.push(current.trim());
  return statements;
}
