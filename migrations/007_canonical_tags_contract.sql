BEGIN;

DROP TRIGGER tags_legacy_name_update_bridge ON tags;
DROP TRIGGER tags_legacy_delete_bridge ON tags;
DROP TRIGGER articles_legacy_tags_bridge ON articles;
DROP TRIGGER article_revisions_legacy_tags_bridge ON article_revisions;
DROP FUNCTION bridge_catalog_legacy_tags();
DROP FUNCTION bridge_article_legacy_tags();
DROP FUNCTION bridge_revision_legacy_tags();
DROP FUNCTION canonical_tag_names_from_ids(uuid[]);
DROP FUNCTION canonical_tag_ids_from_legacy(text[]);
DROP INDEX articles_tags_idx;
ALTER TABLE articles DROP COLUMN tags;
ALTER TABLE article_revisions DROP COLUMN tags;

INSERT INTO schema_migrations (id) VALUES ('007_canonical_tags_contract');

COMMIT;
