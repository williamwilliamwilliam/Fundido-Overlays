# Fundido Overlays Design Document

## Purpose of Fundido Overlays

The goal of Fundido Overlays is to improve game data accessibility by showing
game information in a more obvious way. Often in games, information is presented
in a difficult-to-read way, or provides too much information and is difficult
for a human to parse with high speed.

Fundido Overlays will capture game frames with low latency and evaluate regions of
the screen for different states. Users can specify regions of the screen, and can 
specify rules associated that determine that region's state.

Based on different states, Fundido Overlays will display information on the
screen over the game window. These overlays should, by default, be click-through
and not affect the ability to interact with the game outside of showing on
top of the game. An overlay can be a small icon/picture that shows up, some text,
or simply a real-time feed a region of the screen-capture. Overlays can be positioned
absolutely on the screen, or positioned relative to the mouse cursor. 

Overlays can be arranged in groups. A user may want to see a group of icons that 
show up or disappear based on different states.


### Game Capture
The Game Capture should be implemented in a way that is low-latency and has
minimal performance impact. DXGI could be a good solution here. It should be 
low-latency so real-time feeds of small regions of the capture can be overlayed on 
top of your screen to a place you'd rather see it.

### Core UI
A Fundido Overlays UI should be an application used to:
- Set up and preview the game capture, somewhat similar to OBS.
- Set up 'Monitored Regions' of the capture that should have state rules associated with it
- Set up 'States' for 'Monitored Regions' that hold an evaluated value about that region. An example may a state called 'isRegionBlack?'. A 'State Calculation' is responsible for calculating a value based on the region, and setting the state. Multiple rules can be defined.
    - 'State Calculation' may be a variety of types, but initially it will be 'Median Pixel Color'. A median pixel color on the monitored region should be calculated. In a 'State Calculation', A user should be able to specify a color and the state associated with that. For example, #000000 = 'No' and #ffffff = 'Yes' and #808080 = 'Maybe'. Whatever specified color most closely matches the median should be the current state. In the UI, the median color should be shown along with some indication of how closely different Statethere should be matching confidence shown in the UI so users can see how closely each 'State Calculation' matches - a percentage would be easy to understand.
- Set up an 'Overlay Group' which controls where its overlays are positioned, which direction they grow, and how they are aligned/justified.
- Set up an 'Overlay' which shows up or displays based on various states.
    - An 'Overlay' must be within a group.
    - An 'Overlay' can be an icon, text, or a mirror of the monitored region itself.
- Easily Export and Import 'Monitored Regions' via strings. This is to allow users to easily share their rules.
    - Include their 'States', and their 'State Calculations'
    - Import/Export strings should be JSON
- Easily Export and Import 'Overlay Groups' via strings. This is to allow users to easily share their overlays.
- There should be a debug console in the app that logs information about what is happening under the covers. In case there are items that are exceptionally chatty, there should be a multiselect option to filter certain log events out.


## Division of Responsibilities
The app back-end can be split up into these major responsibilities
- Persistence of Configuration: Game Capture, Monitored Regions, Overlays
    - Developers have experience with Postgres and nosql solutions. Primitive JSON file storage is also ok.
- Game Capture functionality
    - Using an approach such as DXGI, pull a game's feed (or entire display) so it can be previewed in the UI and evaluated for state.
- Calculating of State
    - Constantly using Monitored Regions, State definitions, and State Calculations to set state in real-time.
- Displaying of Overlays
    - Overlays reacts to state to decide how and when to display

### Building / Packaging as an Application
This should ideally build and run as simply as possible. It would be convenient
if it could be executed as a single exe file on Windows. There are no plans
to run this outside of windows, but it's possible mac support would be desired
in the future.


### Documentation

Markdown documentation is preferred.

You should maintain detailed instructions on how to build a release as a developer. 

You should maintain detailed instructions on how to install a release as a user.

You should maintain detailed user documentation that can be navigated/displayed within the UI.


## Stack
The languages and frameworks used should be determined by a combination
of what serves the design well, and what is maintainable by the developer.

Below are competencies of the developer maintaining this application:
- Postgres, nosql, primitive json file storage
- Angular / TypeScript / JavaScript
- Java / Spring