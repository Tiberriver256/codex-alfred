# codex-alfred

Slack "butler" that bridges Slack threads to Codex CLI via the Codex TypeScript SDK.

## Easy install (create your own Slack app)
Each user creates their own Slack app and gets their own tokens. Use the manifest link below to open Slack's app creation flow:

<!-- slack-manifest-link:start -->

[![Create Slack App](https://img.shields.io/badge/Slack-Create%20App-4A154B?logo=slack&logoColor=white)](https://api.slack.com/apps?new_app=1&manifest_yaml=display_information%3A%0A%20%20name%3A%20codex-alfred%0A%20%20description%3A%20Slack%20butler%20that%20bridges%20threads%20to%20Codex%20CLI.%0A%20%20background_color%3A%20%22%234A154B%22%0Afeatures%3A%0A%20%20bot_user%3A%0A%20%20%20%20display_name%3A%20Alfred%0A%20%20%20%20always_online%3A%20false%0Aoauth_config%3A%0A%20%20scopes%3A%0A%20%20%20%20bot%3A%0A%20%20%20%20%20%20-%20app_mentions%3Aread%0A%20%20%20%20%20%20-%20channels%3Ahistory%0A%20%20%20%20%20%20-%20channels%3Aread%0A%20%20%20%20%20%20-%20groups%3Ahistory%0A%20%20%20%20%20%20-%20groups%3Aread%0A%20%20%20%20%20%20-%20im%3Ahistory%0A%20%20%20%20%20%20-%20im%3Aread%0A%20%20%20%20%20%20-%20mpim%3Ahistory%0A%20%20%20%20%20%20-%20mpim%3Aread%0A%20%20%20%20%20%20-%20chat%3Awrite%0A%20%20%20%20%20%20-%20users%3Aread%0Asettings%3A%0A%20%20socket_mode_enabled%3A%20true%0A%20%20event_subscriptions%3A%0A%20%20%20%20bot_events%3A%0A%20%20%20%20%20%20-%20app_mention%0A%20%20interactivity%3A%0A%20%20%20%20is_enabled%3A%20false%0A%20%20org_deploy_enabled%3A%20false)

<!-- slack-manifest-link:end -->

See `spec.md` for the product/technical spec.
