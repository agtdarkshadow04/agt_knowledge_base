import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../components/I18n';
import { parseOpenApi } from '../../lib/openapi';
import { ApiReference } from './ApiReference';

const document = parseOpenApi({
  openapi: '3.1.0',
  info: { title: 'AGT Knowledge Base API', version: '2.0.0' },
  paths: {
    '/api/tags': {
      post: {
        operationId: 'createTag',
        tags: ['Tags'],
        summary: 'Create a tag.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', minLength: 2, maxLength: 40 },
                  limit: { type: 'integer', minimum: 1, maximum: 10000, default: 50 },
                  note: { type: 'string', default: '' },
                },
              },
            },
          },
        },
        responses: { 201: { description: 'Created.' } },
      },
    },
  },
});

function renderIn(language: string) {
  localStorage.setItem('agt_knowledge_base_settings', JSON.stringify({ language }));
  return render(<I18nProvider><ApiReference document={document} /></I18nProvider>);
}

describe('ApiReference', () => {
  afterEach(() => localStorage.clear());

  it('words schema limits in English, with grouped numbers (I18N-3, I18N-5)', () => {
    renderIn('en');
    expect(screen.getByText('2–40 characters')).toBeInTheDocument();
    expect(screen.getByText('1–10,000')).toBeInTheDocument();
    expect(screen.getByText('default 50')).toBeInTheDocument();
    expect(screen.getByText('default empty')).toBeInTheDocument();
  });

  it('words schema limits in the reader\'s language (I18N-3, I18N-5)', () => {
    renderIn('fr');
    expect(screen.getByText('2 à 40 caractères')).toBeInTheDocument();
    // French groups digits with a narrow no-break space, which the text normalizer rewrites.
    expect(screen.getByText(/^1–10\s000$/)).toBeInTheDocument();
    expect(screen.getByText('vide par défaut')).toBeInTheDocument();
  });
});
