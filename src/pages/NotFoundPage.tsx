import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return <div className="page state-panel"><p className="eyebrow">Signal lost // 404</p><h1>Transmission not found</h1><p>The requested archive coordinate does not exist.</p><Link className="button button-primary" to="/">Return to archive</Link></div>;
}
