import { LogPanel } from './LogPanel';

/** The Audit log tab (LOG-19, REPO-1). It has no way to change the log. */
export function AuditLogPanel() {
  return <LogPanel kind="audit" />;
}
