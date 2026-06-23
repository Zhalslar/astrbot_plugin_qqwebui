# astrbot_plugin_qqwebui Design

## 1. Goal

`astrbot_plugin_qqwebui` is a plugin-based Web QQ panel running inside the AstrBot dashboard.

Target effect:

- View QQ private chats and group chats in a Web page
- Display recent messages by listening to `AiocqhttpMessageEvent`
- Send messages through the `aiocqhttp` adapter
- Query contact and group metadata through OneBot V11 public APIs
- Keep the page smooth through explicit cache layers and incremental rendering

This plugin is not a full QQ official client clone. It should be a focused, stable, maintainable Web panel built on top of AstrBot plugin APIs and OneBot V11 capabilities.

## 2. Core Constraint

The implementation must respect the boundary of OneBot V11 public APIs:

- OneBot V11 can send and recall messages
- OneBot V11 can fetch a single message by `message_id`
- OneBot V11 can fetch login info, friend list, group list, group/member info
- OneBot V11 can fetch image or record files already referenced by message segments
- OneBot V11 does not provide a standard "list all historical private/group messages" API
- OneBot V11 does not provide a standard "list all conversations with server-side pagination" API

This means the first version of `qqwebui` should be designed as:

- An event-driven conversation panel
- A local-session-backed recent message viewer
- A contact/group metadata viewer

It should not be described as "full historical QQ chat sync" unless a specific OneBot implementation adds private extension APIs and we explicitly add support for them later.

## 3. Product Positioning

### 3.1 MVP scope

The first practical version should support:

- Conversation list built from locally observed sessions
- Private chat and group chat message timeline
- Text/image/file/reply/basic forward message rendering
- Sending text, image, and common AstrBot-supported message segments
- Group member list sidebar or drawer
- Contact search from cached friend/group/member metadata
- Unread counts based on locally observed events
- Simple online status and adapter status

### 3.2 Not in MVP

These should not be treated as mandatory in phase 1:

- Full remote history backfill
- Cross-device read status sync
- Message edit sync
- Voice call / video call
- QQ-specific advanced panels that are outside OneBot V11 public API
- Deep virtualization for tens of thousands of messages before we have real scale evidence

## 4. High-Level Architecture

The plugin should be split into four layers:

1. Event intake layer
2. Domain/cache layer
3. Web API layer
4. Frontend page layer

Recommended directory shape:

```text
data/plugins/astrbot_plugin_qqwebui/
  main.py
  metadata.yaml
  config.py
  page_controller.py
  DESIGN.md
  core/
    models.py
    constants.py
    store.py
    service.py
    serializer.py
    event_router.py
    sender.py
    cache/
      base.py
      message_cache.py
      session_cache.py
      contact_cache.py
      group_cache.py
      unread_cache.py
  pages/
    dashboard/
      index.html
      styles.css
      app.js
      api.js
      store.js
      renderers.js
      components/
```

This keeps responsibilities clear without over-fragmenting tiny logic blocks.

## 5. Backend Design

### 5.1 Main plugin entry

`main.py` responsibilities:

- Initialize config
- Initialize cache/store/service objects
- Register page APIs
- Listen to `AiocqhttpMessageEvent`
- Listen to outgoing decoration result when useful for optimistic UI and sent-message echo

Recommended runtime graph:

```text
QQWebui
  -> PluginConfig
  -> QQWebuiStore
  -> QQWebuiService
  -> QQWebuiPageController
```

### 5.2 Event intake

`AiocqhttpMessageEvent` is the primary source of truth for new incoming messages.

The event handler should:

- Ignore non-`aiocqhttp` traffic
- Normalize message into a local message model
- Compute a stable session key
- Update session cache
- Update message cache
- Update unread cache
- Optionally enrich sender/group metadata through throttled cache refresh

Recommended session key format:

- Private chat: `private:{user_id}`
- Group chat: `group:{group_id}`

Recommended message model fields:

- `message_id`
- `session_id`
- `chat_type`
- `sender_id`
- `sender_name`
- `group_id`
- `timestamp`
- `raw_segments`
- `plain_text`
- `is_self`
- `reply_message_id`
- `mentions`
- `attachments`

### 5.3 Sending path

The page should not call OneBot directly. It should go through a service layer.

`sender.py` responsibilities:

- Resolve target session
- Convert page payload into `MessageChain`
- Call `AiocqhttpMessageEvent.send_message()` or adapter bot methods
- Persist the sent message into local cache after success
- Generate temporary pending messages before success if frontend needs optimistic rendering

### 5.4 Service layer

`service.py` should provide the main use cases:

- `get_status()`
- `list_sessions()`
- `get_session_detail(session_id)`
- `list_messages(session_id, before=None, limit=50)`
- `send_message(session_id, payload)`
- `mark_session_read(session_id)`
- `list_contacts(query="", scope="all")`
- `refresh_contacts(force=False)`
- `refresh_group_members(group_id, force=False)`

This layer should be the only place allowed to combine caches and OneBot API calls.

### 5.5 Store layer

`store.py` can hold in-memory state plus optional light persistence.

Recommended composition:

- `SessionCache`
- `MessageCache`
- `ContactCache`
- `GroupCache`
- `UnreadCache`

Optional later addition:

- lightweight local persistence file under plugin data directory to restore recent sessions after restart

Phase 1 can work with memory-first design, but the interfaces should not assume memory forever.

## 6. Cache Design

The cache layer is mandatory for this plugin because the frontend will feel laggy without it.

### 6.1 Design principles

- Memory-first reads
- TTL-based metadata refresh
- Bounded message retention per session
- Separate hot cache and slow refresh paths
- Never block page rendering on bulk remote refresh

### 6.2 Message cache

Purpose:

- Keep recent messages for each active session
- Support fast timeline rendering
- Avoid repeated `get_msg` hydration unless necessary

Suggested behavior:

- Store last `N` messages per session, default `200`
- Global cap, for example `5000` or `10000` messages
- Evict oldest messages first
- Maintain an index by `message_id`

Suggested APIs:

- `append(message)`
- `list(session_id, before=None, limit=50)`
- `get(message_id)`
- `clear_session(session_id)`

### 6.3 Session cache

Purpose:

- Build the conversation list instantly
- Track latest message preview, pin state, unread count snapshot

Stored fields:

- `session_id`
- `chat_type`
- `title`
- `avatar`
- `last_message_id`
- `last_message_preview`
- `last_timestamp`
- `unread_count`
- `member_count` for groups when available

Suggested APIs:

- `upsert_session(session)`
- `touch_with_message(session_id, message)`
- `list_sorted()`

### 6.4 Contact cache

Purpose:

- Prevent page open and search from repeatedly calling `get_friend_list`
- Support fuzzy local search

Suggested source APIs:

- `get_login_info`
- `get_friend_list`
- `get_stranger_info`

Suggested strategy:

- Friend list full refresh TTL: `300s`
- Stranger info TTL: `1800s`
- On-demand miss fill for unknown user IDs

### 6.5 Group cache

Purpose:

- Prevent repeated `get_group_list`, `get_group_info`, `get_group_member_list` calls
- Support group sidebar and member mention popup

Suggested strategy:

- Group list TTL: `300s`
- Group info TTL: `300s`
- Group member list TTL: `120s`
- Single member info TTL: `300s`

### 6.6 Unread cache

Purpose:

- Keep unread counts cheap and deterministic

Suggested behavior:

- Increment on incoming message when session is not active in current page state
- Reset when `mark_session_read(session_id)` is called
- Store only counts, not complex read pointers, in phase 1

### 6.7 Refresh protection

Every remote refresh should have request coalescing.

That means:

- If multiple page requests ask for the same group member list during one in-flight fetch, only send one OneBot request
- All callers await the same task result

This is important to avoid front-end stalls caused by duplicate backend fetch bursts.

## 7. Data Model

Suggested normalized backend models:

### 7.1 Session

```text
SessionSummary
- session_id: str
- chat_type: "private" | "group"
- target_id: str
- title: str
- avatar: str
- unread_count: int
- last_message_preview: str
- last_timestamp: int
```

### 7.2 Message

```text
MessageRecord
- message_id: str
- session_id: str
- chat_type: str
- sender_id: str
- sender_name: str
- is_self: bool
- timestamp: int
- plain_text: str
- segments: list[dict]
- quote: dict | None
- attachments: list[dict]
```

### 7.3 Contact

```text
ContactRecord
- id: str
- type: "friend" | "group" | "group_member" | "stranger"
- title: str
- subtitle: str
- avatar: str
- extra: dict
```

## 8. Web API Design

Routes should be registered under:

- `/astrbot_plugin_qqwebui/page/...`

Recommended endpoints:

- `GET /page/status`
- `GET /page/sessions`
- `GET /page/messages`
- `POST /page/send`
- `POST /page/read`
- `GET /page/contacts`
- `POST /page/contacts/refresh`
- `GET /page/group/members`
- `POST /page/upload`

### 8.1 `GET /page/status`

Returns:

- adapter online state
- login info
- cache summary
- frontend limits

### 8.2 `GET /page/sessions`

Params:

- `keyword`
- `chat_type`
- `limit`

Returns:

- sorted conversation summaries

### 8.3 `GET /page/messages`

Params:

- `session_id`
- `before`
- `limit`

Returns:

- message list
- whether there are older locally cached messages

Important:

- In phase 1 this endpoint returns only locally known messages
- If the user expects old history from before plugin startup, the UI should say "history is limited to locally observed/cache-restored messages"

### 8.4 `POST /page/send`

Request body:

- `session_id`
- `elements`

Response:

- normalized sent message
- delivery status

### 8.5 `POST /page/read`

Request body:

- `session_id`

Response:

- updated unread count

### 8.6 `GET /page/contacts`

Params:

- `keyword`
- `scope=all|friends|groups|members`

Returns:

- contact search results from cache

### 8.7 `POST /page/contacts/refresh`

Purpose:

- manual refresh button
- should return quickly and ideally refresh in background if the cache is warm enough

### 8.8 `GET /page/group/members`

Params:

- `group_id`
- `force`

Returns:

- cached member list

## 9. Frontend Design

The frontend should live in:

- `data/plugins/astrbot_plugin_qqwebui/pages/dashboard`

It should use the built-in `AstrBotPluginPage` bridge.

### 9.1 Page layout

Recommended three-column layout:

1. Left: conversation list
2. Middle: message timeline
3. Right: detail drawer or member panel

Mobile:

- collapse into stacked panes
- conversation list first
- message view second
- detail drawer as overlay

### 9.2 Frontend modules

Recommended JS split:

- `app.js`: bootstrap and event wiring
- `api.js`: bridge API wrappers
- `store.js`: frontend state container
- `renderers.js`: message/session render helpers

Avoid putting all logic into one huge file.

### 9.3 Frontend state

Suggested state fields:

- `sessions`
- `activeSessionId`
- `messagesBySession`
- `contacts`
- `memberPanel`
- `loadingFlags`
- `typingDrafts`
- `uploadQueue`

### 9.4 Rendering strategy

To avoid page jank:

- Render conversation list from cached response first
- Load active session messages after session list is shown
- Use incremental append/prepend, not full list rerender when possible
- Lazy render images
- Debounce search input
- Keep a local draft per session

### 9.5 Message rendering support

Phase 1 should handle:

- Plain text
- Image
- File
- At
- Reply
- Forward summary
- System placeholder for unsupported segments

Unsupported segment rendering should degrade gracefully instead of blocking the whole item.

## 10. Anti-Stutter Strategy

This is a key requirement.

### 10.1 Backend anti-stutter

- All list endpoints must read from cache first
- Remote refresh must be TTL-gated
- Duplicate refresh must be request-coalesced
- Group member fetch must be isolated from main session list loading
- Message normalization must avoid heavy synchronous transformations in the request path

### 10.2 Frontend anti-stutter

- Do not fetch full contact and full member data on initial page load
- Do not rerender all sessions when one unread count changes
- Do not rerender all messages when one message arrives
- Do not block input while sidebar refreshes
- Use optimistic send items for message posting

### 10.3 Suggested preload order

Recommended page load sequence:

1. Load status
2. Load session list
3. Render first paint
4. Load active session messages
5. Refresh contacts in background
6. Load group members only when group session is opened

## 11. Event and Sync Strategy

Because OneBot V11 public APIs do not expose full history listing, sync must be explicit:

- Real-time append from `AiocqhttpMessageEvent`
- Optional detail hydration via `get_msg(message_id)`
- Metadata enrichment via `get_friend_list`, `get_group_list`, `get_group_member_info`, `get_group_member_list`

Important product statement:

- This plugin is "real-time and recent-session oriented"
- Not "cloud history browser"

## 12. Error Handling

The plugin should fail softly:

- If contact refresh fails, session list still works
- If member list fails, chat timeline still works
- If unknown segment type appears, render placeholder
- If adapter is offline, page shows offline state and disables send

Standard response shape is recommended:

```json
{
  "ok": true,
  "data": {},
  "message": ""
}
```

On failure:

```json
{
  "ok": false,
  "error": {
    "message": "..."
  }
}
```

## 13. Security and Permissions

Phase 1 should at least consider:

- Dashboard page access inherits AstrBot dashboard auth
- Message send APIs must not accept arbitrary malformed session IDs
- Uploaded files must be size-limited
- Temporary uploads must go to plugin temp/data directory
- If later adding admin-only functions, split them from normal chat routes

## 14. Current Repository Issues To Fix Before Implementation

The current `astrbot_plugin_qqwebui` skeleton has a few obvious carry-over issues:

- `metadata.yaml` currently uses the wrong plugin `name`
- `config.py` currently uses `PLUGIN_NAME = "astrbot_plugin_apis"`
- `page_controller.py` is empty
- `styles.css` is empty
- `main.py` currently only probes event data and does not persist or expose anything

These should be corrected before feature implementation starts.

## 15. Recommended Delivery Phases

### Phase 1

- Fix skeleton metadata/config names
- Build backend cache/store/service foundation
- Add page APIs: status, sessions, messages, send, read
- Build basic three-column page
- Support real-time recent chats

### Phase 2

- Add contact search and group member panel
- Add reply rendering and sending
- Add file/image upload polish
- Add local persistence for recent sessions/messages

### Phase 3

- Add SSE or polling-based live update push for the page if needed
- Add richer message segment rendering
- Add optional implementation-specific history extension support

## 16. Implementation Notes

Recommended backend-first order:

1. Fix metadata/config constants
2. Define data models
3. Implement cache classes
4. Implement event intake
5. Implement page controller
6. Build frontend around stable APIs

Recommended frontend-first guardrails:

- Keep modules separate
- Keep DOM updates incremental
- Keep search and member loading debounced
- Never make the initial page depend on a full metadata refresh

## 17. Final Decision

The correct design direction for `astrbot_plugin_qqwebui` is:

- Use `AiocqhttpMessageEvent` as the real-time message source
- Use OneBot V11 public APIs for sending and metadata enrichment
- Build a local cache-centered recent-session Web QQ panel
- Treat cache classes as first-class architecture, not optional optimization

This is the simplest design that is correct, smooth, and aligned with the actual protocol boundary.
