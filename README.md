# Schedule Block

Schedule Block inserts standalone SiYuan widget blocks for day and week schedule views.

## Features

- Day and week views
- Day blocks and week blocks stay separate; there is no in-widget day/week switch
- The top-left anchor button jumps back to the bound day or ISO week, and the gear button edits that binding
- Insert from the top bar, command palette, or slash menu
- Drag on the time grid to create events
- Click events to edit title, time, all-day status, color, and notes
- Drag or resize events to adjust time
- Use colors to distinguish schedules

## Scope

Schedule Block is not intended to replace a full calendar system or SiYuan database calendar views. Database calendar views are better suited for managing blocks, tasks, or records with date properties. Existing calendar and schedule plugins often focus on global calendars, daily note navigation, holidays, or task management.

This plugin focuses on a narrower workflow: embedding a lightweight day or week timeline directly inside any SiYuan document, bound to a specific date or ISO week. It is useful when a project note, meeting note, course plan, reading plan, or personal dashboard needs an inline schedule without first creating a database or switching away to a global calendar.

## Data

Events are stored in the SiYuan workspace at:

`/data/storage/schedule-block/events.json`

## License

MIT

---

## Statement

This plugin was made entirely through vibe coding. The tools and models used were roughly:

- Codex (GPT 5.5): 60%
- Antigravity (Gemini 3.5 Flash): 20%
- Claude Code (Fable 5): 10%
- QoderWork (GLM-5.1): 10%

Please use it at your own discretion.
