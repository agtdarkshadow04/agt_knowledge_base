/** Migration files are imported as text (esbuild --loader:.sql=text, DATA-3). */
declare module '*.sql' {
  const sql: string;
  export default sql;
}
