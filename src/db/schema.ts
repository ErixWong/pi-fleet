export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE account (
  id          VARCHAR(32) PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  status      ENUM('active','disabled') NOT NULL DEFAULT 'active',
  created_at  DATETIME NOT NULL,
  deleted_at  DATETIME NULL
) ENGINE=InnoDB`,

  `CREATE TABLE principal (
  id                VARCHAR(32) PRIMARY KEY,
  account_id        VARCHAR(32) NOT NULL,
  kind              ENUM('user','host','agent','service') NOT NULL,
  name              VARCHAR(128) NOT NULL,
  password_hash     VARCHAR(255) NULL,
  host_principal_id VARCHAR(32) NULL,
  reputation_score  INT NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL,
  deleted_at        DATETIME NULL,
  KEY idx_principal_acct (account_id, kind, id),
  CONSTRAINT fk_prn_account FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_prn_host    FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE host_folder (
  host_principal_id VARCHAR(32)  NOT NULL,
  path              VARCHAR(512) NOT NULL,
  last_seen_at      DATETIME     NOT NULL,
  PRIMARY KEY (host_principal_id, path),
  CONSTRAINT fk_host_folder_prn FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE host_control_request (
  id                VARCHAR(32)  NOT NULL PRIMARY KEY,
  host_principal_id VARCHAR(32)  NOT NULL,
  type              ENUM('list_dir') NOT NULL,
  payload           TEXT         NOT NULL,
  status            ENUM('pending','answered','expired') NOT NULL DEFAULT 'pending',
  result            TEXT         NULL,
  requested_at      DATETIME     NOT NULL,
  answered_at       DATETIME     NULL,
  KEY idx_hcr_host_status (host_principal_id, status, id),
  CONSTRAINT fk_hcr_prn FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE device (
  principal_id  VARCHAR(32) PRIMARY KEY,
  hostname      VARCHAR(255) NOT NULL DEFAULT '',
  os            VARCHAR(64)  NOT NULL DEFAULT '',
  run_user      VARCHAR(64)  NULL,
  last_seen_at  DATETIME     NULL,
  created_at    DATETIME NOT NULL,
  CONSTRAINT fk_dev_prn FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE device_executor (
  principal_id  VARCHAR(32) NOT NULL,
  cli           VARCHAR(32) NOT NULL,
  enabled       TINYINT(1) NOT NULL DEFAULT 1,
  selected      TINYINT(1) NOT NULL DEFAULT 0,
  reported_at   DATETIME NOT NULL,
  PRIMARY KEY (principal_id, cli),
  CONSTRAINT fk_devexec_dev FOREIGN KEY (principal_id) REFERENCES device(principal_id)
) ENGINE=InnoDB`,

  `CREATE TABLE api_key (
  id            VARCHAR(32) PRIMARY KEY,
  principal_id  VARCHAR(32) NOT NULL,
  key_hash      CHAR(64) NOT NULL UNIQUE,
  label         VARCHAR(128) NOT NULL DEFAULT '',
  scopes        TEXT NOT NULL,
  created_at    DATETIME NOT NULL,
  last_used_at  DATETIME NULL,
  expires_at    DATETIME NULL,
  revoked_at    DATETIME NULL,
  KEY idx_key_prn (principal_id, revoked_at, id),
  CONSTRAINT fk_key_prn FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE post (
  id                  VARCHAR(32) PRIMARY KEY,
  account_id          VARCHAR(32) NOT NULL,
  kind                ENUM('note','task','message','verdict','channel') NOT NULL,
  subtype             VARCHAR(32) NOT NULL DEFAULT '',
  author_principal_id VARCHAR(32) NOT NULL,
  title               VARCHAR(512) NOT NULL DEFAULT '',
  body                MEDIUMTEXT NOT NULL,
  visibility          ENUM('private','account','public') NOT NULL DEFAULT 'private',
  parent_id           VARCHAR(32) NULL,
  root_id             VARCHAR(32) NOT NULL,
  streaming           TINYINT(1) NOT NULL DEFAULT 0,
  revision            INT UNSIGNED NOT NULL DEFAULT 0,
  reply_count         INT NOT NULL DEFAULT 0,
  created_at          DATETIME NOT NULL,
  edited_at           DATETIME NULL,
  deleted_at          DATETIME NULL,
  KEY idx_post_root   (root_id, id),
  KEY idx_post_parent (parent_id, id),
  KEY idx_post_kind   (account_id, kind, id),
  CONSTRAINT fk_post_acct   FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_post_author FOREIGN KEY (author_principal_id) REFERENCES principal(id),
  CONSTRAINT fk_post_parent FOREIGN KEY (parent_id) REFERENCES post(id)
) ENGINE=InnoDB`,

  `CREATE TABLE post_task (
  post_id               VARCHAR(32) PRIMARY KEY,
  status                ENUM('pending_audit','rejected','open','claimed','submitted',
                             'pending_confirm','done','failed','cancelled') NOT NULL,
  assignee_principal_id VARCHAR(32) NULL,
  is_ready              TINYINT(1) NOT NULL DEFAULT 1,
  workdir               VARCHAR(512) NULL,
  executor              VARCHAR(32) NULL,
  deliverable_spec      TEXT NOT NULL,
  attempts              INT NOT NULL DEFAULT 0,
  max_attempts          INT NOT NULL DEFAULT 3,
  pipeline_step_id      VARCHAR(32) NULL,
  parent_task_id        VARCHAR(32) NULL,
  claimed_at            DATETIME NULL,
  submitted_at          DATETIME NULL,
  closed_at             DATETIME NULL,
  KEY idx_pt_status     (status, is_ready, post_id),
  KEY idx_pt_assignee   (assignee_principal_id, status, post_id),
  KEY idx_pt_step       (pipeline_step_id, status, post_id),
  CONSTRAINT fk_pt_post   FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_pt_assign FOREIGN KEY (assignee_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE post_channel (
  post_id           VARCHAR(32) PRIMARY KEY,
  host_principal_id VARCHAR(32) NOT NULL,
  workdir           VARCHAR(512) NULL,
  run_user          VARCHAR(64) NULL,
  name              VARCHAR(128) NOT NULL DEFAULT '',
  status            ENUM('open','archived') NOT NULL DEFAULT 'open',
  CONSTRAINT fk_pc_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_pc_host FOREIGN KEY (host_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE post_verdict (
  post_id        VARCHAR(32) PRIMARY KEY,
  decision       ENUM('accept','reject') NOT NULL,
  opinion        TEXT NOT NULL DEFAULT '',
  target_task_id VARCHAR(32) NOT NULL,
  attempt_no     INT NOT NULL DEFAULT 0,
  source         ENUM('llm','human') NOT NULL DEFAULT 'human',
  KEY idx_pv_target (target_task_id, post_id),
  CONSTRAINT fk_pv_post   FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_pv_target FOREIGN KEY (target_task_id) REFERENCES post(id)
) ENGINE=InnoDB`,

  `CREATE TABLE post_target (
  post_id       VARCHAR(32) NOT NULL,
  principal_id  VARCHAR(32) NOT NULL,
  role          ENUM('assignee','mention','watcher') NOT NULL,
  read_at       DATETIME NULL,
  created_at    DATETIME NOT NULL,
  PRIMARY KEY (post_id, principal_id, role),
  KEY idx_ptgt_inbox (principal_id, role, post_id),
  CONSTRAINT fk_ptgt_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_ptgt_prn  FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE post_summary (
  root_id        VARCHAR(32) NOT NULL,
  revision       INT UNSIGNED NOT NULL,
  summary        MEDIUMTEXT NOT NULL,
  up_to_post_id  VARCHAR(32) NOT NULL,
  model          VARCHAR(128) NOT NULL DEFAULT '',
  tokens_in      INT NOT NULL DEFAULT 0,
  tokens_out     INT NOT NULL DEFAULT 0,
  created_at     DATETIME NOT NULL,
  PRIMARY KEY (root_id, revision)
) ENGINE=InnoDB`,

  `CREATE TABLE attachment (
  id                 VARCHAR(32) PRIMARY KEY,
  account_id         VARCHAR(32) NOT NULL,
  owner_principal_id VARCHAR(32) NOT NULL,
  filename           VARCHAR(512) NOT NULL,
  mime               VARCHAR(128) NOT NULL DEFAULT '',
  size_bytes         BIGINT NOT NULL DEFAULT 0,
  sha256             CHAR(64) NOT NULL,
  relative_path      VARCHAR(1024) NOT NULL,
  scan_status        ENUM('pending','clean','infected','skipped','error') NOT NULL DEFAULT 'pending',
  created_at         DATETIME NOT NULL,
  deleted_at         DATETIME NULL,
  UNIQUE KEY uq_att_owner_sha (owner_principal_id, sha256),
  KEY idx_att_acct  (account_id, created_at, id),
  KEY idx_att_scan  (scan_status, id),
  CONSTRAINT fk_att_acct  FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_att_owner FOREIGN KEY (owner_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE deliverable (
  id            VARCHAR(32) PRIMARY KEY,
  post_id       VARCHAR(32) NOT NULL,
  name          VARCHAR(255) NOT NULL,
  version       INT UNSIGNED NOT NULL DEFAULT 1,
  attachment_id VARCHAR(32) NULL,
  note          TEXT NOT NULL DEFAULT '',
  current       TINYINT(1) NOT NULL DEFAULT 1,
  current_key   VARCHAR(512) GENERATED ALWAYS AS
                (CASE WHEN current = 1 THEN CONCAT(post_id, ':', name) ELSE NULL END) STORED,
  created_at    DATETIME NOT NULL,
  UNIQUE KEY uq_dlv_version (post_id, name, version),
  UNIQUE KEY uq_dlv_current (current_key),
  KEY idx_dlv_att (attachment_id),
  CONSTRAINT fk_dlv_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_dlv_att  FOREIGN KEY (attachment_id) REFERENCES attachment(id)
) ENGINE=InnoDB`,

  `CREATE TABLE event (
  id                VARCHAR(32) PRIMARY KEY,
  account_id        VARCHAR(32) NULL,
  actor_principal_id VARCHAR(32) NULL,
  action            VARCHAR(64) NOT NULL,
  resource_type     VARCHAR(32) NOT NULL,
  resource_id       VARCHAR(32) NULL,
  before_state      MEDIUMTEXT NULL,
  after_state       MEDIUMTEXT NULL,
  payload           MEDIUMTEXT NULL,
  retention         ENUM('audit','notify') NOT NULL DEFAULT 'audit',
  occurred_at       DATETIME NOT NULL,
  published_at      DATETIME NULL,
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   DATETIME NULL,
  last_error        VARCHAR(500) NOT NULL DEFAULT '',
  KEY idx_evt_outbox (published_at, next_attempt_at, id),
  KEY idx_evt_res    (resource_type, resource_id, id),
  KEY idx_evt_actor  (actor_principal_id, id),
  KEY idx_evt_action (action, id)
) ENGINE=InnoDB`,

  `CREATE TABLE pipeline (
  id                 VARCHAR(32) PRIMARY KEY,
  account_id         VARCHAR(32) NOT NULL,
  owner_principal_id VARCHAR(32) NOT NULL,
  name               VARCHAR(255) NOT NULL,
  status             ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at         DATETIME NOT NULL,
  deleted_at         DATETIME NULL,
  KEY idx_pipe_owner (account_id, owner_principal_id, id)
) ENGINE=InnoDB`,

  `CREATE TABLE pipeline_step (
  id                 VARCHAR(32) PRIMARY KEY,
  pipeline_id        VARCHAR(32) NOT NULL,
  seq                INT NOT NULL,
  name               VARCHAR(255) NOT NULL DEFAULT '',
  depends_on_step_id VARCHAR(32) NULL,
  trigger_id         VARCHAR(32) NULL,
  spec               TEXT NULL,
  created_at         DATETIME NOT NULL,
  UNIQUE KEY uq_step_seq (pipeline_id, seq),
  KEY idx_step_dep (depends_on_step_id),
  CONSTRAINT fk_step_pipe FOREIGN KEY (pipeline_id) REFERENCES pipeline(id)
) ENGINE=InnoDB`,

  `CREATE TABLE \`trigger\` (
  id                 VARCHAR(32) PRIMARY KEY,
  account_id         VARCHAR(32) NOT NULL,
  owner_principal_id VARCHAR(32) NOT NULL,
  cron_expr          VARCHAR(128) NOT NULL,
  timezone           VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
  enabled            TINYINT(1) NOT NULL DEFAULT 1,
  next_due_at        DATETIME NULL,
  last_fired_at      DATETIME NULL,
  target_kind        ENUM('post','task','pipeline') NOT NULL,
  target_spec        TEXT NULL,
  created_at         DATETIME NOT NULL,
  deleted_at         DATETIME NULL,
  KEY idx_trg_due (enabled, next_due_at, id),
  CONSTRAINT fk_trg_acct  FOREIGN KEY (account_id) REFERENCES account(id),
  CONSTRAINT fk_trg_owner FOREIGN KEY (owner_principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,

  `CREATE TABLE setting (
  setting_key            VARCHAR(128) PRIMARY KEY,
  value                  MEDIUMTEXT NOT NULL,
  updated_at             DATETIME NOT NULL,
  updated_by_principal_id VARCHAR(32) NULL
) ENGINE=InnoDB`,

  `CREATE TABLE setting_history (
  id                     VARCHAR(32) PRIMARY KEY,
  setting_key            VARCHAR(128) NOT NULL,
  old_value              MEDIUMTEXT NULL,
  new_value              MEDIUMTEXT NULL,
  changed_by_principal_id VARCHAR(32) NULL,
  changed_at              DATETIME NOT NULL,
  KEY idx_seth_key (setting_key, id)
) ENGINE=InnoDB`,

  `CREATE TABLE llm_provider (
  id         VARCHAR(32) PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL,
  name       VARCHAR(128) NOT NULL,
  base_url   VARCHAR(512) NOT NULL,
  api_key    VARCHAR(512) NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  deleted_at DATETIME NULL
) ENGINE=InnoDB`,

  `CREATE TABLE llm_model (
  id          VARCHAR(32) PRIMARY KEY,
  provider_id VARCHAR(32) NOT NULL,
  model       VARCHAR(128) NOT NULL,
  vision      TINYINT(1) NOT NULL DEFAULT 0,
  price_in    DECIMAL(12,6) NOT NULL DEFAULT 0,
  price_out   DECIMAL(12,6) NOT NULL DEFAULT 0,
  max_tokens  INT NOT NULL DEFAULT 4096,
  temperature DECIMAL(4,2) NOT NULL DEFAULT 0.20,
  enabled     TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL,
  UNIQUE KEY uq_model (provider_id, model),
  CONSTRAINT fk_model_prov FOREIGN KEY (provider_id) REFERENCES llm_provider(id)
) ENGINE=InnoDB`,

  `CREATE TABLE llm_call (
  id         VARCHAR(32) PRIMARY KEY,
  model_id   VARCHAR(32) NULL,
  purpose    VARCHAR(32) NOT NULL,
  tokens_in  INT NOT NULL DEFAULT 0,
  tokens_out INT NOT NULL DEFAULT 0,
  cost       DECIMAL(12,6) NOT NULL DEFAULT 0,
  ref_type   VARCHAR(32) NULL,
  ref_id     VARCHAR(32) NULL,
  created_at DATETIME NOT NULL,
  KEY idx_call_time (created_at, id),
  KEY idx_call_ref (ref_type, ref_id, id)
) ENGINE=InnoDB`,

  `CREATE TABLE tag (
  id         VARCHAR(32) PRIMARY KEY,
  account_id VARCHAR(32) NOT NULL,
  name       VARCHAR(64) NOT NULL,
  category   VARCHAR(32) NOT NULL DEFAULT 'general',
  UNIQUE KEY uq_tag (account_id, category, name)
) ENGINE=InnoDB`,

  `CREATE TABLE post_tag (
  post_id VARCHAR(32) NOT NULL,
  tag_id  VARCHAR(32) NOT NULL,
  PRIMARY KEY (post_id, tag_id),
  KEY idx_ptag_tag (tag_id, post_id),
  CONSTRAINT fk_ptag_post FOREIGN KEY (post_id) REFERENCES post(id),
  CONSTRAINT fk_ptag_tag  FOREIGN KEY (tag_id) REFERENCES tag(id)
) ENGINE=InnoDB`,

  `CREATE TABLE reputation_event (
  id          VARCHAR(32) PRIMARY KEY,
  principal_id VARCHAR(32) NOT NULL,
  delta       INT NOT NULL,
  reason      VARCHAR(64) NOT NULL,
  ref_type    VARCHAR(32) NULL,
  ref_id      VARCHAR(32) NULL,
  created_at  DATETIME NOT NULL,
  KEY idx_rep_prn (principal_id, id),
  CONSTRAINT fk_rep_prn FOREIGN KEY (principal_id) REFERENCES principal(id)
) ENGINE=InnoDB`,
];

export const SCHEMA_TABLE_NAMES = SCHEMA_STATEMENTS.map((statement) => {
  const match = statement.match(/^CREATE TABLE\s+`?([a-z_]+)`?/i);
  if (!match) throw new Error(`Unable to determine table name from schema statement: ${statement}`);
  return match[1];
});
