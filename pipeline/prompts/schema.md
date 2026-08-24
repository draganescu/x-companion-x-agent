---
task_type: schema
required: [package, lifecycle_argument, scaffold_files, route_probe_note, writable_files]
---
You are implementing the handlers of ONE schema package inside an already-generated
scaffold. The gate (static policy scan + throwaway-WordPress boot + live route probes +
post-uninstall diff) decides if it ships; you will not get a conversation.

From the wp-schema skill (the method — the skill is the source of truth):

> S3 — Everything REST-visible: no meta without a show_in_rest schema, no CPT the
> agent cannot read back through /wp/v2. If it is not visible in the manifest
> afterwards, it does not exist.
>
> S5 — The build test is not skippable: every declared post type in /wp/v2/types,
> every meta key in the REST surface, every route dispatched live (2xx for a valid
> nonce'd call, 401/403 for an unauthenticated protected one), and — after
> deactivation, in a fresh request — nothing left registered. A static policy scan
> rejects $wpdb, eval, exec outright (schema_policy). Core APIs only.
>
> S6 — Anonymous write flows: nonce verified in the handler, honeypot checked,
> inputs sanitized server-side, entries created with a moderated (pending) status so
> nothing publicly submitted is publicly visible by default.

The package, as the brief declared it: {{package}}
Why this data has a lifecycle: {{lifecycle_argument}}

{{route_probe_note}}

The scaffold as generated — implement the handlers against the embedded intent;
keep every registration REST-visible; wp_slash() arrays before inserting:
{{scaffold_files}}

Output ONLY JSON: {"files": {"<name>": "<content>", ...}} where <name> is drawn from
exactly this writable set: {{writable_files}}. Return only the files you change,
complete; PHP files start with <?php.
