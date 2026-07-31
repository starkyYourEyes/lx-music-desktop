export interface SchemaColumnContract {
  name: string
  type: string
  notNull: boolean
  primaryKeyPosition: number
}

export interface SchemaIndexContract {
  name: string
  columns: string[]
  unique: boolean
  partial: boolean
}

export interface SchemaForeignKeyContract {
  name: string
  table: string
  from: string[]
  to: string[]
  onUpdate: string
  onDelete: string
}

export interface SchemaTableContract {
  name: string
  columns: SchemaColumnContract[]
  indexes: SchemaIndexContract[]
  foreignKeys: SchemaForeignKeyContract[]
}

export interface SchemaContract {
  tables: SchemaTableContract[]
}

const column = (
  name: string,
  type: string,
  notNull = false,
  primaryKeyPosition = 0,
): SchemaColumnContract => ({ name, type, notNull, primaryKeyPosition })

export const databaseSchemaContract: SchemaContract = {
  tables: [
    {
      name: 'db_info',
      columns: [column('id', 'INTEGER', true, 1), column('field_name', 'TEXT'), column('field_value', 'TEXT')],
      indexes: [{ name: 'db_info.id.unique', columns: ['id'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'my_list',
      columns: [
        column('id', 'TEXT', true, 1),
        column('name', 'TEXT', true),
        column('source', 'TEXT'),
        column('sourceListId', 'TEXT'),
        column('position', 'INTEGER', true),
        column('locationUpdateTime', 'INTEGER'),
      ],
      indexes: [{ name: 'my_list.id.primary', columns: ['id'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'my_list_music_info',
      columns: [
        column('id', 'TEXT', true),
        column('listId', 'TEXT', true),
        column('name', 'TEXT', true),
        column('singer', 'TEXT', true),
        column('source', 'TEXT', true),
        column('interval', 'TEXT'),
        column('meta', 'TEXT', true),
      ],
      indexes: [
        { name: 'my_list_music_info.id_listId.unique', columns: ['id', 'listId'], unique: true, partial: false },
        { name: 'index_my_list_music_info', columns: ['id', 'listId'], unique: false, partial: false },
      ],
      foreignKeys: [],
    },
    {
      name: 'my_list_music_info_order',
      columns: [column('listId', 'TEXT', true), column('musicInfoId', 'TEXT', true), column('order', 'INTEGER', true)],
      indexes: [{ name: 'index_my_list_music_info_order', columns: ['listId', 'musicInfoId'], unique: false, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'music_info_other_source',
      columns: [
        column('source_id', 'TEXT', true),
        column('id', 'TEXT', true),
        column('source', 'TEXT', true),
        column('name', 'TEXT', true),
        column('singer', 'TEXT', true),
        column('meta', 'TEXT', true),
        column('order', 'INTEGER', true),
      ],
      indexes: [
        { name: 'music_info_other_source.source_id_id.unique', columns: ['source_id', 'id'], unique: true, partial: false },
        { name: 'index_music_info_other_source', columns: ['source_id', 'id'], unique: false, partial: false },
      ],
      foreignKeys: [],
    },
    {
      name: 'lyric',
      columns: [column('id', 'TEXT', true), column('source', 'TEXT', true), column('type', 'TEXT', true), column('text', 'TEXT', true)],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: 'music_url',
      columns: [column('id', 'TEXT', true), column('url', 'TEXT', true)],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: 'download_list',
      columns: [
        column('id', 'TEXT', true, 1),
        column('isComplate', 'INTEGER', true),
        column('status', 'TEXT', true),
        column('statusText', 'TEXT', true),
        column('progress_downloaded', 'INTEGER', true),
        column('progress_total', 'INTEGER', true),
        column('url', 'TEXT'),
        column('quality', 'TEXT', true),
        column('ext', 'TEXT', true),
        column('fileName', 'TEXT', true),
        column('filePath', 'TEXT', true),
        column('musicInfo', 'TEXT', true),
        column('position', 'INTEGER', true),
      ],
      indexes: [{ name: 'download_list.id.primary', columns: ['id'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'dislike_list',
      columns: [column('type', 'TEXT', true), column('content', 'TEXT', true), column('meta', 'TEXT')],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: 'schema_migrations',
      columns: [
        column('version', 'INTEGER', false, 1),
        column('name', 'TEXT', true),
        column('checksum', 'TEXT', true),
        column('applied_at_ms', 'INTEGER', true),
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: 'migration_markers',
      columns: [
        column('name', 'TEXT', false, 1),
        column('source_sha256', 'TEXT', true),
        column('completed_at_ms', 'INTEGER', true),
        column('details_json', 'TEXT', true),
      ],
      indexes: [{ name: 'migration_markers.name.primary', columns: ['name'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'account_profiles',
      columns: [
        column('provider', 'TEXT', false, 1),
        column('profile_json', 'TEXT', true),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [{ name: 'account_profiles.provider.primary', columns: ['provider'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'local_state',
      columns: [
        column('key', 'TEXT', false, 1),
        column('version', 'INTEGER', true),
        column('value_json', 'TEXT', true),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [{ name: 'local_state.key.primary', columns: ['key'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'playlist_metadata',
      columns: [
        column('playlist_id', 'TEXT', false, 1),
        column('is_auto_update', 'INTEGER', true),
        column('update_time_ms', 'INTEGER', true),
        column('profile_json', 'TEXT'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [{ name: 'playlist_metadata.playlist_id.primary', columns: ['playlist_id'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'search_history',
      columns: [
        column('term', 'TEXT', false, 1),
        column('recency_seq', 'INTEGER', true),
        column('last_used_at_ms', 'INTEGER'),
        column('use_count', 'INTEGER', true),
      ],
      indexes: [
        { name: 'search_history.term.primary', columns: ['term'], unique: true, partial: false },
        { name: 'search_history.recency_seq.unique', columns: ['recency_seq'], unique: true, partial: false },
      ],
      foreignKeys: [],
    },
  ],
}

export default databaseSchemaContract
