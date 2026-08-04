export interface SchemaColumnContract {
  name: string
  type: string
  notNull: boolean
  primaryKeyPosition: number
  defaultValue?: string | null
}

export interface SchemaIndexContract {
  name: string
  columns: string[]
  unique: boolean
  partial: boolean
  where?: string
}

export interface SchemaCheckContract {
  name: string
  expression: string
}

export type SchemaValue = string | number | null

export interface SchemaRequiredRowContract {
  name: string
  values: Record<string, SchemaValue>
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
  checks?: SchemaCheckContract[]
  requiredRows?: SchemaRequiredRowContract[]
}

export interface SchemaContract {
  tables: SchemaTableContract[]
}

const column = (
  name: string,
  type: string,
  notNull = false,
  primaryKeyPosition = 0,
  defaultValue?: string | null,
): SchemaColumnContract => ({ name, type, notNull, primaryKeyPosition, defaultValue })

const MAX_SAFE_INTEGER = 9007199254740991

const safeInteger = (name: string, minimum = 0, maximum = MAX_SAFE_INTEGER): SchemaCheckContract => ({
  name: `${name}.integer`,
  expression: `typeof(${name}) = 'integer' AND ${name} BETWEEN ${minimum} AND ${maximum}`,
})

const nullableSafeInteger = (name: string, minimum = 0, maximum = MAX_SAFE_INTEGER): SchemaCheckContract => ({
  name: `${name}.integer`,
  expression: `${name} IS NULL OR (typeof(${name}) = 'integer' AND ${name} BETWEEN ${minimum} AND ${maximum})`,
})

export const databaseSchema6Contract: SchemaContract = {
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
    {
      name: 'track_snapshots',
      columns: [
        column('track_id', 'INTEGER', false, 1),
        column('source', 'TEXT', true),
        column('source_track_id', 'TEXT', true),
        column('name', 'TEXT', true),
        column('singer', 'TEXT', true),
        column('duration_ms', 'INTEGER'),
        column('playable_payload_json', 'TEXT'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [{
        name: 'track_snapshots.source_source_track_id.unique',
        columns: ['source', 'source_track_id'],
        unique: true,
        partial: false,
      }],
      foreignKeys: [],
      checks: [
        safeInteger('track_id', -MAX_SAFE_INTEGER),
        nullableSafeInteger('duration_ms'),
        {
          name: 'playable_payload_json.valid',
          expression: 'playable_payload_json IS NULL OR json_valid(playable_payload_json)',
        },
        safeInteger('updated_at_ms'),
      ],
    },
    {
      name: 'playback_sessions',
      columns: [
        column('session_id', 'INTEGER', false, 1),
        column('session_uuid', 'TEXT', true),
        column('playback_group_uuid', 'TEXT', true),
        column('segment_no', 'INTEGER', true),
        column('track_id', 'INTEGER', true),
        column('local_day', 'TEXT', true),
        column('utc_offset_minutes', 'INTEGER', true),
        column('context_type', 'TEXT'),
        column('context_id', 'TEXT'),
        column('start_reason', 'TEXT', true),
        column('end_reason', 'TEXT'),
        column('started_at_ms', 'INTEGER', true),
        column('ended_at_ms', 'INTEGER'),
        column('start_position_ms', 'INTEGER', true),
        column('last_position_ms', 'INTEGER', true),
        column('duration_ms', 'INTEGER'),
        column('played_ms', 'INTEGER', true, 0, '0'),
        column('active_ms', 'INTEGER', true, 0, '0'),
        column('cumulative_played_ms', 'INTEGER', true, 0, '0'),
        column('cumulative_active_ms', 'INTEGER', true, 0, '0'),
        column('checkpoint_seq', 'INTEGER', true, 0, '0'),
        column('state', 'TEXT', true),
        column('recent_allowed', 'INTEGER', true),
        column('stats_allowed', 'INTEGER', true),
        column('created_at_ms', 'INTEGER', true),
      ],
      indexes: [
        { name: 'playback_sessions.session_uuid.unique', columns: ['session_uuid'], unique: true, partial: false },
        {
          name: 'playback_sessions.playback_group_uuid_segment_no.unique',
          columns: ['playback_group_uuid', 'segment_no'],
          unique: true,
          partial: false,
        },
        {
          name: 'playback_one_open_group',
          columns: ['playback_group_uuid'],
          unique: true,
          partial: true,
          where: "state IN ('playing','paused')",
        },
        { name: 'playback_retention', columns: ['state', 'ended_at_ms', 'session_id'], unique: false, partial: false },
      ],
      foreignKeys: [{
        name: 'playback_sessions.track_id',
        table: 'track_snapshots',
        from: ['track_id'],
        to: ['track_id'],
        onUpdate: 'NO ACTION',
        onDelete: 'NO ACTION',
      }],
      checks: [
        safeInteger('session_id', -MAX_SAFE_INTEGER),
        safeInteger('segment_no'),
        safeInteger('track_id', -MAX_SAFE_INTEGER),
        { name: 'local_day.length', expression: 'length(local_day) = 10' },
        safeInteger('utc_offset_minutes', -840, 840),
        {
          name: 'start_reason.enum',
          expression: `start_reason IN (
            'select','next','previous','auto','restore','remote','day_boundary','statistics_clear'
          )`,
        },
        {
          name: 'end_reason.enum',
          expression: `end_reason IS NULL OR end_reason IN (
            'next','previous','select','dislike','stop','error','load_timeout','buffer_timeout',
            'queue_removed','natural_end','day_boundary','statistics_clear'
          )`,
        },
        safeInteger('started_at_ms'),
        {
          name: 'ended_at_ms.integer',
          expression: `ended_at_ms IS NULL OR (
            typeof(ended_at_ms) = 'integer' AND ended_at_ms BETWEEN started_at_ms AND ${MAX_SAFE_INTEGER}
          )`,
        },
        safeInteger('start_position_ms'),
        safeInteger('last_position_ms'),
        nullableSafeInteger('duration_ms'),
        safeInteger('played_ms'),
        safeInteger('active_ms'),
        safeInteger('cumulative_played_ms'),
        safeInteger('cumulative_active_ms'),
        safeInteger('checkpoint_seq'),
        { name: 'state.enum', expression: "state IN ('playing','paused','closed','interrupted')" },
        {
          name: 'recent_allowed.boolean',
          expression: "typeof(recent_allowed) = 'integer' AND recent_allowed IN (0,1)",
        },
        {
          name: 'stats_allowed.boolean',
          expression: "typeof(stats_allowed) = 'integer' AND stats_allowed IN (0,1)",
        },
        safeInteger('created_at_ms'),
        { name: 'cumulative_played_ms.total', expression: 'cumulative_played_ms >= played_ms' },
        { name: 'cumulative_active_ms.total', expression: 'cumulative_active_ms >= active_ms' },
        {
          name: 'state.terminal',
          expression: `(state IN ('playing','paused') AND ended_at_ms IS NULL AND end_reason IS NULL)
            OR (state = 'closed' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL)
            OR (state = 'interrupted' AND ended_at_ms IS NOT NULL AND end_reason IS NULL)`,
        },
      ],
    },
    {
      name: 'playback_events',
      columns: [
        column('event_id', 'INTEGER', false, 1),
        column('session_id', 'INTEGER', true),
        column('sequence_no', 'INTEGER', true),
        column('event_type', 'TEXT', true),
        column('occurred_at_ms', 'INTEGER', true),
        column('position_ms', 'INTEGER', true),
        column('reason', 'TEXT'),
        column('details_json', 'TEXT'),
      ],
      indexes: [{
        name: 'playback_events.session_id_sequence_no.unique',
        columns: ['session_id', 'sequence_no'],
        unique: true,
        partial: false,
      }],
      foreignKeys: [{
        name: 'playback_events.session_id',
        table: 'playback_sessions',
        from: ['session_id'],
        to: ['session_id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      }],
      checks: [
        safeInteger('event_id', -MAX_SAFE_INTEGER),
        safeInteger('session_id', -MAX_SAFE_INTEGER),
        safeInteger('sequence_no'),
        {
          name: 'event_type.enum',
          expression: "event_type IN ('play_start','pause','resume','seek','skip','play_end','error')",
        },
        safeInteger('occurred_at_ms'),
        safeInteger('position_ms'),
        { name: 'details_json.valid', expression: 'details_json IS NULL OR json_valid(details_json)' },
        {
          name: 'reason.matrix',
          expression: `(event_type = 'error' AND reason IS NULL)
            OR (reason IS NOT NULL AND (
              (event_type = 'play_start' AND reason IN (
                'select','next','previous','auto','restore','remote','day_boundary','statistics_clear'
              ))
              OR (event_type IN ('pause','resume') AND reason IN ('user','device','remote','recovery'))
              OR (event_type = 'seek' AND reason IN (
                'bar','hotkey','media_session','lyric','party','restore','buffer_recovery'
              ))
              OR (event_type = 'skip' AND reason IN (
                'next','previous','select','dislike','stop','error','load_timeout','buffer_timeout','queue_removed'
              ))
              OR (event_type = 'play_end' AND reason = 'natural_end')
            ))`,
        },
      ],
    },
    {
      name: 'recent_tracks',
      columns: [
        column('track_id', 'INTEGER', false, 1),
        column('recency_seq', 'INTEGER', true),
        column('last_session_id', 'INTEGER'),
        column('last_played_at_ms', 'INTEGER'),
        column('legacy_rank', 'INTEGER'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [
        { name: 'recent_tracks.recency_seq.unique', columns: ['recency_seq'], unique: true, partial: false },
        { name: 'recent_tracks_order', columns: ['recency_seq'], unique: false, partial: false },
      ],
      foreignKeys: [
        {
          name: 'recent_tracks.track_id',
          table: 'track_snapshots',
          from: ['track_id'],
          to: ['track_id'],
          onUpdate: 'NO ACTION',
          onDelete: 'CASCADE',
        },
        {
          name: 'recent_tracks.last_session_id',
          table: 'playback_sessions',
          from: ['last_session_id'],
          to: ['session_id'],
          onUpdate: 'NO ACTION',
          onDelete: 'SET NULL',
        },
      ],
      checks: [
        safeInteger('track_id', -MAX_SAFE_INTEGER),
        safeInteger('recency_seq', -MAX_SAFE_INTEGER),
        nullableSafeInteger('last_session_id', -MAX_SAFE_INTEGER),
        nullableSafeInteger('last_played_at_ms'),
        nullableSafeInteger('legacy_rank', 1, 520),
        safeInteger('updated_at_ms'),
      ],
    },
    {
      name: 'listening_daily',
      columns: [
        column('local_day', 'TEXT', true, 1),
        column('baseline_played_ms', 'INTEGER', true, 0, '0'),
        column('live_played_ms', 'INTEGER', true, 0, '0'),
        column('baseline_active_ms', 'INTEGER', true, 0, '0'),
        column('live_active_ms', 'INTEGER', true, 0, '0'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [{ name: 'listening_daily.local_day.primary', columns: ['local_day'], unique: true, partial: false }],
      foreignKeys: [],
      checks: [
        { name: 'local_day.length', expression: 'length(local_day) = 10' },
        safeInteger('baseline_played_ms'),
        safeInteger('live_played_ms'),
        safeInteger('baseline_active_ms'),
        safeInteger('live_active_ms'),
        safeInteger('updated_at_ms'),
      ],
    },
    {
      name: 'listening_tracks',
      columns: [
        column('track_id', 'INTEGER', false, 1),
        column('baseline_played_ms', 'INTEGER', true, 0, '0'),
        column('live_played_ms', 'INTEGER', true, 0, '0'),
        column('baseline_active_ms', 'INTEGER', true, 0, '0'),
        column('live_active_ms', 'INTEGER', true, 0, '0'),
        column('last_played_at_ms', 'INTEGER'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [],
      foreignKeys: [{
        name: 'listening_tracks.track_id',
        table: 'track_snapshots',
        from: ['track_id'],
        to: ['track_id'],
        onUpdate: 'NO ACTION',
        onDelete: 'CASCADE',
      }],
      checks: [
        safeInteger('track_id', -MAX_SAFE_INTEGER),
        safeInteger('baseline_played_ms'),
        safeInteger('live_played_ms'),
        safeInteger('baseline_active_ms'),
        safeInteger('live_active_ms'),
        nullableSafeInteger('last_played_at_ms'),
        safeInteger('updated_at_ms'),
      ],
    },
    {
      name: 'activity_totals',
      columns: [
        column('id', 'INTEGER', false, 1),
        column('baseline_played_ms', 'INTEGER', true, 0, '0'),
        column('live_played_ms', 'INTEGER', true, 0, '0'),
        column('baseline_active_ms', 'INTEGER', true, 0, '0'),
        column('live_active_ms', 'INTEGER', true, 0, '0'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'id.singleton', expression: 'id = 1' },
        safeInteger('baseline_played_ms'),
        safeInteger('live_played_ms'),
        safeInteger('baseline_active_ms'),
        safeInteger('live_active_ms'),
        safeInteger('updated_at_ms'),
      ],
      requiredRows: [{
        name: 'singleton',
        values: { id: 1 },
      }],
    },
    {
      name: 'projection_state',
      columns: [
        column('name', 'TEXT', true, 1),
        column('version', 'INTEGER', true),
        column('last_session_id', 'INTEGER'),
        column('visible_after_ms', 'INTEGER'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [{ name: 'projection_state.name.primary', columns: ['name'], unique: true, partial: false }],
      foreignKeys: [{
        name: 'projection_state.last_session_id',
        table: 'playback_sessions',
        from: ['last_session_id'],
        to: ['session_id'],
        onUpdate: 'NO ACTION',
        onDelete: 'SET NULL',
      }],
      checks: [
        { name: 'name.enum', expression: "name IN ('recent','statistics')" },
        safeInteger('version', 1),
        nullableSafeInteger('last_session_id', -MAX_SAFE_INTEGER),
        nullableSafeInteger('visible_after_ms'),
        safeInteger('updated_at_ms'),
      ],
      requiredRows: [
        {
          name: 'recent',
          values: { name: 'recent' },
        },
        {
          name: 'statistics',
          values: { name: 'statistics' },
        },
      ],
    },
    {
      name: 'playback_resume_state',
      columns: [
        column('id', 'INTEGER', false, 1),
        column('playback_group_uuid', 'TEXT', true),
        column('checkpoint_seq', 'INTEGER', true),
        column('source', 'TEXT', true),
        column('source_track_id', 'TEXT', true),
        column('list_id', 'TEXT'),
        column('index_hint', 'INTEGER'),
        column('position_ms', 'INTEGER', true),
        column('duration_ms', 'INTEGER'),
        column('updated_at_ms', 'INTEGER', true),
      ],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'id.singleton', expression: 'id = 1' },
        safeInteger('checkpoint_seq'),
        nullableSafeInteger('index_hint', 0, 1000000),
        safeInteger('position_ms'),
        nullableSafeInteger('duration_ms'),
        safeInteger('updated_at_ms'),
      ],
    },
  ],
}

export const databaseSchema7Contract: SchemaContract = {
  tables: databaseSchema6Contract.tables.filter(table =>
    table.name != 'music_info_other_source' && table.name != 'music_url'),
}

// Existing callers validate the transition schema explicitly through version 6.
export const databaseSchemaContract = databaseSchema6Contract

export default databaseSchemaContract
