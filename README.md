# Schedule Block

Schedule Block embeds lightweight day and week timelines directly inside SiYuan documents.

It is not a global calendar and it is not a replacement for database calendar views. It focuses on a narrower workflow: putting an editable schedule inside the note you are already writing, without creating a database or switching to a separate calendar page.

## Highlights

- Standalone day blocks and week blocks.
- Each block is bound to a date or ISO week, with a toolbar anchor that jumps back to that bound range.
- New blocks can infer their initial date or week from the document title; if no supported title date is found, they use the current date.
- Settings allow changing the bound date/week and the default event duration.
- New events default to 30 minutes, with per-block options for 15, 30, 45, or 60 minutes.
- Newly inserted schedule blocks are tall enough to show the full 24-hour timeline by default.
- Drag-select to create events; single-clicking blank space does nothing, while double-clicking creates a default-duration event.
- Click an event to edit title, date, time, all-day state, color, and notes.
- Drag or resize events to adjust time.
- Hover an event with notes to show the note in a lightweight tooltip; it disappears when the mouse leaves.
- Use `Cmd/Ctrl+Z` to undo the previous schedule data operation.
- Use the Add Schedule command, with `Option+Command+K` by default, to quickly add an event outside a specific schedule block.
- Export the current day or week schedule block as a PNG screenshot.

## Interaction Details

- Events created from drag-select, double-click, or the toolbar plus button auto-save while editing.
- Clicking outside the editor keeps the auto-saved result.
- Pressing `Esc` or clicking Cancel truly cancels the current edit: new drafts are removed, and existing events roll back to their original values.
- Cross-day events show both start and end dates, so midnight boundaries such as `Jun 12 23:00 -> Jun 13 00:00` stay explicit.
- Short events use a compact single-line layout and keep their height tied to the real duration, so neighboring events are not covered.

## Colors and Filtering

- Events can be colored with a Google Calendar-style palette.
- A toolbar filter button lets you choose which event colors are visible in the current schedule block.
- The filter palette uses the same color order as the event editor.
- When all colors are selected, all events are shown; clicking a color in this state switches directly to "only this color".
- While filtering, click more colors to expand or reduce the visible set, or use All to restore every color.

## Date Headers and Weather

The day header uses a compact two-line layout:

- Line 1: Gregorian date and lunar date.
- Line 2: weekday and weather icon.

Weather supports four simple states: sunny, overcast, rain, and snow. Click the weather icon to set or clear the day weather. Empty days use a neutral weather placeholder icon, not a specific weather state.

Weather data is stored separately from event data.

## Usage

After enabling the plugin, insert a schedule block from:

- the top-bar Schedule Block menu,
- the command palette,
- or the slash menu with `/日历块` or `/周历块`.

Inside a block, you can:

- use Add Schedule from the top-bar menu, or press `Option+Command+K`, to open the same event editor centered over the SiYuan window with a frosted background overlay,
- use document titles such as `2026-6-13`, `2026/06/13`, `2026年6月13日`, `20260613`, `2026-W26`, or `2026年第26周` to auto-bind newly inserted blocks,
- click the anchor button to return to the bound date or week,
- click the gear button to edit the binding and default event duration,
- click the filter button to filter events by color,
- click the screenshot button to export the current schedule block view as a PNG; the export hides transient UI and the current-time indicator, and prefers Desktop as the default save location,
- click the same settings, filter, plus, or weather button again to close its popover,
- drag-select a time range to create an event,
- double-click a blank time slot to create a default-duration event,
- click an existing event to edit or delete it,
- hover an event with notes to preview the note,
- drag existing events to adjust time,
- click the weather icon in the day header to set the day weather.

## Data

Events are stored in the SiYuan workspace at:

`/data/storage/schedule-block/events.json`

Weather is stored separately at:

`/data/storage/schedule-block/weather.json`

Block-level state such as view type, bound date/week, and default event duration is stored in SiYuan block attributes.

## Good Fits

- Daily notes, weekly plans, and personal dashboards.
- Project schedules embedded in project documents.
- Meeting agendas inside meeting notes.
- Course plans, reading plans, and writing plans.
- Any note that benefits from an inline timeline.

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
