# Fundido Overlays — User Guide

## What is Fundido Overlays?

Fundido Overlays captures your game screen and watches specific areas for changes. When those areas match conditions you define, overlays appear on top of your game — icons, text, or live previews of hard-to-see information.

Everything is click-through by default, so your game input is never blocked.

---

## Core Concepts

### Game Capture

The capture source is what Fundido reads frames from — typically your primary display. You can configure the target frame rate (how often it checks the screen). Lower FPS uses less CPU; higher FPS gives more responsive overlays.

### Monitored Regions

A monitored region is a rectangular area of the captured screen. You define where it is (position and size), and Fundido continuously analyzes the pixels in that area.

For example, you might define a region over a game's health bar, a cooldown icon, or a status indicator.

### State Calculations

Each monitored region can have one or more state calculations. A state calculation looks at the region's pixels and produces a state value — a label like "Yes", "No", "Ready", "OnCooldown", etc.

**Median Pixel Color** is the first supported calculation type. It works like this:

1. Fundido computes the median color of all pixels in the region.
2. You define a set of reference colors, each mapped to a state value. For example:
   - `#000000` (black) → "Off"
   - `#FF0000` (red) → "Danger"
   - `#00FF00` (green) → "Safe"
3. Whichever reference color is closest to the actual median color becomes the current state.
4. A confidence percentage is shown for each mapping so you can see how close the match is.

### Overlay Groups

An overlay group controls where overlays appear and how they are arranged:

- **Position**: Absolute (fixed screen coordinates) or relative to your mouse cursor.
- **Grow Direction**: When multiple overlays in the group are visible, do they stack to the right, left, up, or down?
- **Alignment**: Start, center, or end alignment within the group.

### Overlays

An overlay is a single visual element that appears based on state conditions. Each overlay belongs to a group and can be:

- **Icon**: An image file that appears when conditions are met.
- **Text**: A text label that appears when conditions are met.
- **Region Mirror**: A live, real-time copy of a monitored region — useful for moving hard-to-see game info to a more convenient spot on your screen.

Each overlay has one or more visibility conditions. All conditions must be true for the overlay to appear. A condition checks: "Is [this region]'s [this calculation] currently equal to [this value]?"

---

## Sharing Configurations

### Exporting

You can export your monitored regions or overlay groups as JSON strings. Use the Export button in the app, copy the resulting text, and share it with others.

Monitored region exports include all state calculations and their color mappings.

### Importing

Paste a JSON string into the Import dialog. The imported regions or overlay groups will be added to your configuration.

**Note:** Importing overlay groups that reference monitored regions requires those regions to exist in your config (matched by ID). Export and import the regions first.

---

## Debug Console

The debug console shows a live log of what Fundido is doing: frame captures, state calculations, overlay visibility changes, configuration saves, etc.

Some log categories can be very chatty (especially capture and state calculation logs at high FPS). Use the category filter to show only the logs you care about.
