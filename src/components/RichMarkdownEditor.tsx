import '@mdxeditor/editor/style.css';
import {
  BoldItalicUnderlineToggles,
  CreateLink,
  headingsPlugin,
  linkPlugin,
  listsPlugin,
  ListsToggle,
  MDXEditor,
  quotePlugin,
  thematicBreakPlugin,
  toolbarPlugin,
  UndoRedo,
} from '@mdxeditor/editor';

interface RichMarkdownEditorProps {
  value: string;
  onChange(value: string): void;
}

export function RichMarkdownEditor({ value, onChange }: RichMarkdownEditorProps) {
  return (
    <div className="rich-editor-shell">
      <MDXEditor
        markdown={value}
        onChange={onChange}
        contentEditableClassName="rich-editor-content"
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
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
