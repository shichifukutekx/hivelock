/**
 * Models often bring MySQL habits to PostgreSQL: ? for values, `backticks` around names, and line breaks sent as the
 * two characters \n. PostgreSQL rejects each of these outside a quoted part, so turning them into what was meant
 * cannot change a statement that would have worked. Quoted strings, quoted names, dollar quotes and comments are kept
 * exactly as they are.
 */

type Piece = { kept: boolean; text: string };

/** Splits SQL into the parts that must be left alone and the parts that are plain SQL. */
function split(sql: string): Piece[] {
  const pieces: Piece[] = [];
  let plain = "";
  const keep = (text: string) => {
    if (plain) pieces.push({ kept: false, text: plain });
    plain = "";
    pieces.push({ kept: true, text });
  };
  for (let i = 0; i < sql.length;) {
    const rest = sql.slice(i);
    let kept: string | undefined;
    if (rest[0] === "'") kept = /^'(?:[^']|'')*'?/.exec(rest)![0];
    else if (rest[0] === '"') kept = /^"(?:[^"]|"")*"?/.exec(rest)![0];
    else if (rest.startsWith("--")) kept = /^--[^\n]*/.exec(rest)![0];
    else if (rest.startsWith("/*")) kept = /^\/\*[\s\S]*?(?:\*\/|$)/.exec(rest)![0];
    else if (rest[0] === "$" && !/^\$\d/.test(rest)) kept = /^(\$[A-Za-z_]*\$)[\s\S]*?(?:\1|$)/.exec(rest)?.[0];
    else if (rest[0] === "`") {
      // A MySQL-quoted name becomes a PostgreSQL-quoted one, and is then left alone like any quoted name.
      const name = /^`([^`]*)`/.exec(rest);
      if (name) {
        keep(`"${name[1]!.replaceAll('"', '""')}"`);
        i += name[0].length;
        continue;
      }
    }
    if (kept) {
      keep(kept);
      i += kept.length;
    } else {
      plain += rest[0];
      i += 1;
    }
  }
  if (plain) pieces.push({ kept: false, text: plain });
  return pieces;
}

export function asPostgres(sql: string, values: readonly unknown[]): string {
  const pieces = split(sql).map((piece) => (piece.kept ? piece : {
    kept: false,
    text: piece.text.replace(/\\[nrt]/g, " "),
  }));
  const plain = pieces.filter((piece) => !piece.kept).map((piece) => piece.text).join("");
  const marks = (plain.match(/\?/g) ?? []).length;
  // ? is also a JSON operator in PostgreSQL, so it only becomes $1, $2 when it clearly stands for the values given.
  if (marks > 0 && marks === values.length && !/\$\d/.test(plain)) {
    let next = 0;
    for (const piece of pieces) if (!piece.kept) piece.text = piece.text.replace(/\?/g, () => `$${++next}`);
  }
  return pieces.map((piece) => piece.text).join("");
}

export const POSTGRES_GUIDE = "This database is PostgreSQL: put values in values and refer to them as $1, $2 in sql, quote names with double quotes, and send one statement.";
export const MYSQL_GUIDE = "This database is MySQL: put values in values and refer to them as ? in sql, and send one statement.";
