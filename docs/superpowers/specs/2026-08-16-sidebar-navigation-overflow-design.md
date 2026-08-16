# Sidebar Navigation Overflow Design

## Goal

Keep every sidebar destination reachable at the smallest main-window size. Preserve the current icon and hit-target sizes, keep Settings visible outside the scrolling menu by default, and let users control the scrollbar appearance and Settings entry location.

## User Experience

- Keep the navigation icons, hit targets, and spacing at their current sizes.
- Let the main navigation list scroll when its content exceeds the available sidebar height.
- Keep the Settings icon fixed at the bottom of the sidebar when the user selects the bottom location.
- Add a Sidebar group to Basic Settings with these controls:
  - "Show sidebar scrollbar", enabled by default.
  - "Settings entry location", with "Sidebar bottom" selected by default and "Account menu" as the alternative.
- Apply both settings as soon as the user changes them.
- Hiding the scrollbar must preserve mouse-wheel, touchpad, and keyboard scrolling.

## Sidebar Layout

`NavBar.vue` will divide the available height into two flex regions:

- The main menu uses the remaining height, sets `min-height: 0`, and scrolls vertically on overflow.
- The Settings menu does not shrink or join the main menu's scroll container.

The main menu will reuse the application's existing thin scrollbar styling while `common.isShowSidebarScrollbar` is enabled. A CSS Modules class will hide the WebKit scrollbar when the setting is disabled. The class will not change `overflow-y: auto`.

The bottom Settings list will render only when `common.sidebarSettingLocation` resolves to `bottom`. A missing or unrecognized location will also resolve to `bottom`, so an imported or damaged setting cannot remove the Settings entry.

## Account Menu

The account control will render for both window-control positions. When window controls appear on the left, the sidebar order will be window controls, account avatar, and navigation.

When `common.sidebarSettingLocation` resolves to `accountMenu`:

- The bottom Settings list will not render.
- The account popover will add a separator below the QQ Music and NetEase Cloud Music rows.
- A full-width row with a settings icon and localized label will navigate to `/setting`.
- Activating the row will close the popover before starting navigation.

The account popover will omit the Settings row in bottom mode. The two modes therefore expose one Settings entry rather than duplicate links.

## Settings Contract

Add these fields to `LX.AppSetting` and the default settings object:

```ts
'common.isShowSidebarScrollbar': boolean
'common.sidebarSettingLocation': 'bottom' | 'accountMenu'
```

The defaults will be `true` and `bottom`. The existing settings initialization starts with the current defaults and merges stored keys, so profiles created by older versions receive both defaults without a storage-schema change.

Basic Settings will use the existing `base-checkbox` pattern. The scrollbar control will use a boolean checkbox. The location control will use two radio-style checkbox options bound to `bottom` and `accountMenu`. Simplified Chinese, Traditional Chinese, and English locale files will define the group and control labels.

## Error Handling And Accessibility

- Treat only the exact `accountMenu` value as account-menu mode. Other runtime values fall back to the bottom location.
- Follow the existing sidebar navigation policy for duplicate or rejected router navigation.
- Give the account-menu Settings row a button element, an accessible label, and the same keyboard activation behavior as other buttons.
- Keep the navigation links in the scroll container focusable. Keyboard focus can move through destinations even when some links start outside the visible area.

## Verification

Add focused regression tests that verify:

- The main menu can shrink and scroll while the bottom region remains fixed.
- The hidden-scrollbar class removes the scrollbar without disabling vertical overflow.
- Bottom mode renders the bottom Settings link and omits the account-menu row.
- Account-menu mode omits the bottom Settings link and renders the popover row.
- Left-positioned window controls and the account avatar render together.
- The account-menu Settings action closes the popover and requests `/setting` navigation.
- Defaults, Basic Settings bindings, fallback behavior, and all three locale labels match the contract.

Run the focused Node tests, lint the touched source files, and build the renderer production bundle.

## Scope

This change covers sidebar overflow, scrollbar visibility, account control availability, and the Settings entry location. It does not resize navigation items, preserve a sidebar scroll position across launches, change account authentication, or alter routes outside `/setting`.
