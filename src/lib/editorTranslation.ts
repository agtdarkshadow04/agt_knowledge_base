/**
 * MDXEditor's `translation` prop (I18N-3): every toolbar and dialog string
 * passes through here with its key, English default and `{{name}}`
 * interpolations. Until the Phase 9 string tables exist the English default is
 * the only locale; `messages` is where the translated strings plug in.
 */
export type EditorMessages = Readonly<Record<string, string>>;

export function editorTranslation(messages: EditorMessages = {}) {
  return (key: string, defaultValue: string, interpolations: Record<string, unknown> = {}) => {
    const template = messages[key] ?? defaultValue;
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => (name in interpolations ? String(interpolations[name]) : match));
  };
}
