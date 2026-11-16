import '@mdxeditor/editor/style.css';
import { type RefObject, useEffect, useRef } from 'react';
import {
  BlockTypeSelect,
  BoldItalicUnderlineToggles,
  CreateLink,
  headingsPlugin,
  linkDialogPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  MDXEditor,
  quotePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from '@mdxeditor/editor';
import { editorTranslation } from '../lib/editorTranslation';

const translation = editorTranslation();

interface RichMarkdownEditorProps {
  value: string;
  onChange(value: string): void;
}

/**
 * MDXEditor's toolbar select keeps focus from returning to its trigger when it
 * closes, so Escape would leave focus on <body>. Put it back on the trigger
 * (A11Y-2, and the limits of the MDXEditor deviation in AGENTS.md). Radix
 * closes the select from a document listener, so this one runs on document too.
 */
function useSelectFocusReturn(shell: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    let trigger: HTMLElement | null = null;
    function remember(event: Event) {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.mdxeditor-toolbar [role="combobox"]') : null;
      if (target && shell.current?.contains(target)) trigger = target;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !trigger || !(event.target instanceof Element) || !event.target.closest('.mdxeditor-select-content')) return;
      const opener = trigger;
      requestAnimationFrame(() => {
        if ((document.activeElement === document.body || document.activeElement === null) && opener.isConnected) opener.focus();
      });
    }
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('keydown', remember, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', remember, true);
      document.removeEventListener('keydown', remember, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [shell]);
}

export function RichMarkdownEditor({ value, onChange }: RichMarkdownEditorProps) {
  const shell = useRef<HTMLDivElement>(null);
  useSelectFocusReturn(shell);
  return (
    <div className="rich-editor-shell" ref={shell}>
      <MDXEditor
        className="dark-theme"
        translation={translation}
        markdown={value}
        onChange={onChange}
        contentEditableClassName="rich-editor-content"
        plugins={[
          headingsPlugin({ allowedHeadingLevels: [1, 2, 3] }),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles />
                <ListsToggle />
                <CreateLink />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}

