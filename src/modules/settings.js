"use strict";

const Gettext = imports.gettext.domain("org.gnome.Shell.Extensions.GSConnect");
const _ = Gettext.gettext;
const Lang = imports.lang;

const GdkPixbuf = imports.gi.GdkPixbuf;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gtk = imports.gi.Gtk;

// Local Imports
imports.searchPath.push(gsconnect.datadir);
const Client = imports.client;
const KeybindingsWidget = imports.widgets.keybindings;
const Sound = imports.modules.sound;


/**
 * A simple dialog for selecting a device
 */
var DeviceChooser = new Lang.Class({
    Name: "GSConnectDeviceChooser",
    Extends: Gtk.Dialog,

    _init: function (params) {
        this.parent({
            use_header_bar: true,
            application: Gio.Application.get_default(),
            default_width: 300,
            default_height: 200
        });
        this.set_keep_above(true);

        // HeaderBar
        let headerBar = this.get_header_bar();
        headerBar.title = _("Select a Device");
        headerBar.subtitle = params.title;
        headerBar.show_close_button = false;

        let selectButton = this.add_button(_("Select"), Gtk.ResponseType.OK);
        selectButton.sensitive = false;
        this.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
        this.set_default_response(Gtk.ResponseType.OK);

        // Device List
        let scrolledWindow = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER
        });
        this.get_content_area().add(scrolledWindow);

        this.list = new Gtk.ListBox({ activate_on_single_click: false });
        this.list.connect("row-activated", (list, row) => {
            this.response(Gtk.ResponseType.OK);
        });
        this.list.connect("selected-rows-changed", () => {
            selectButton.sensitive = (this.list.get_selected_rows().length);
        });
        scrolledWindow.add(this.list);

        this._populate(params.devices);
        scrolledWindow.show_all();
    },

    _populate: function (devices) {
        for (let device of devices) {
            let row = new Gtk.ListBoxRow();
            row.device = device;
            this.list.add(row);

            let box = new Gtk.Box({
                margin: 6,
                spacing: 6
            });
            row.add(box);

            let icon = new Gtk.Image({
                icon_name: device.type,
                pixel_size: 32
            });
            box.add(icon);

            let name = new Gtk.Label({
                label: device.name,
                halign: Gtk.Align.START,
                hexpand: true
            });
            box.add(name);
        }
    }
});


var SidebarRow = new Lang.Class({
    Name: "GSConnectSidebarRow",
    Extends: Gtk.ListBoxRow,

    _init: function (params) {
        this.parent({
            selectable: true,
            visible: true
        });

        this.type = params.type || undefined;
        this.set_name(params.name);

        this.box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_left: 8,
            margin_right: 8,
            margin_bottom: 12,
            margin_top: 12,
            visible: true
        });
        this.add(this.box);

        this.icon = new Gtk.Image({
            icon_name: params.icon_name,
            pixel_size: 16,
            visible: true
        });
        this.box.add(this.icon);

        this.title = new Gtk.Label({
            label: params.title,
            halign: Gtk.Align.START,
            hexpand: true,
            valign: Gtk.Align.CENTER,
            vexpand: true,
            visible: true
        });
        this.box.add(this.title);

        if (params.go_next) {
            this.go_next = new Gtk.Image({
                icon_name: "go-next-symbolic",
                pixel_size: 16,
                halign: Gtk.Align.END,
                visible: true
            });
            this.box.add(this.go_next);
        }
    }
});


var PrefsWidget = Lang.Class({
    Name: "GSConnectPrefsWidget",
    Extends: Gtk.Grid,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/prefs.ui",
    Children: [
        "stack", "switcher", "sidebar",
        "shell-list",
        "show-indicators", "show-offline", "show-unpaired", "show-battery",
        "extensions-list",
        "files-integration", "webbrowser-integration",
        "advanced-list",
        "debug-mode", "debug-window",
        "help", "help-list"
    ],

    _init: function (application=false) {
        this.parent();

        // Sidebar
        this.help.type = "device";
        this.switcher.set_header_func(this._switcher_separators);
        this.switcher.connect("row-selected", (box, row) => {
            row = row || this.switcher.get_row_at_index(0);
            let name = row.get_name() || null;

            this.stack.set_visible_child_name(name);

            if (this.sidebar.get_child_by_name(name)) {
                if (this.headerbar) {
                    this.headerbar.title = row.title.label;
                } else {
                    this.get_toplevel().get_titlebar().title = row.title.label;
                }

                this.sidebar.set_visible_child_name(name);
                this._prevButton.visible = true;
            }
        });
        this.switcher.select_row(this.switcher.get_row_at_index(0));

        // FIXME FIXME
        // Init UI Elements
        this._setHeaderbar();
        this._connectTemplate();

        // We were instantiated by the GtkApplication
        if (application) {
            this.daemon = application;

            this.daemon.connect("notify::devices", (daemon) => {
                this._devicesChanged();
            });
            this._devicesChanged();
        // We were instantiated by the Shell, we need a proxy
        } else {
            this.daemon = new Client.Daemon();

            this._watchdog = Gio.bus_watch_name(
                Gio.BusType.SESSION,
                "org.gnome.Shell.Extensions.GSConnect",
                Gio.BusNameWatcherFlags.NONE,
                (c, n, o) => this._serviceAppeared(c, n, o),
                (c, n) => this._serviceVanished(c, n)
            );
        }

        // Broadcasting
        this.connect("destroy", () => {
            GLib.source_remove(this._refreshSource);
        });

        this._refreshSource = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            5,
            () => {
                if (this.sidebar.get_visible_child_name() === "switcher") {
                    this.daemon.broadcast();
                }
                return true;
            }
        );
    },

    _bind_bool: function (settings, key, label) {
        // Watch the setting for changes
        settings.connect("changed::" + key, (settings) => {
            label.label = settings.get_boolean(key) ? _("On") : _("Off");
        });
        // Init the label
        label.label = settings.get_boolean(key) ? _("On") : _("Off");

        // Watch the Gtk.ListBox for activations
        let row = label.get_parent().get_parent();
        let box = row.get_parent();

        box.connect("row-activated", (box, arow) => {
            if (row === arow) {
                // Set the boolean to the inverse of the label "value"
                settings.set_boolean(key, (label.label === _("Off")));
            }
        });
    },

    /**
     * UI Setup and template connecting
     */
    _setHeaderbar: function () {
        // About Button
        let aboutButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "help-about-symbolic",
                pixel_size: 16,
                visible: true
            }),
            always_show_image: true,
            visible: true
        });
        aboutButton.connect("clicked", (button) => {
            let dialog = new Gtk.AboutDialog({
                authors: [ "Andy Holmes <andrew.g.r.holmes@gmail.com>" ],
                //logo_icon_name: gsconnect.app_id,
                logo: GdkPixbuf.Pixbuf.new_from_resource_at_scale(
                    gsconnect.app_path + "/" + gsconnect.app_id + ".svg",
                    128,
                    128,
                    true
                ),
                program_name: _("GSConnect"),
                version: gsconnect.metadata.version,
                website: gsconnect.metadata.url,
                license_type: Gtk.License.GPL_2_0,
                transient_for: this.get_toplevel(),
                modal: true
            });
            dialog.connect("delete-event", dialog => dialog.destroy());
            dialog.show();
        });

        // Previous Button
        this._prevButton = new Gtk.Button({
            image: new Gtk.Image({
                icon_name: "go-previous-symbolic",
                pixel_size: 16,
                visible: true
            }),
            always_show_image: true,
            visible: false
        });
        this._prevButton.connect("clicked", (button) => {
            this.headerbar.title = _("GSConnect");
            this.sidebar.set_visible_child_name("switcher");

            this.switcher.get_row_at_index(0).emit("activate");
            this._prevButton.visible = false;
        });

        // Hack for gnome-shell-extension-prefs
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 0, () => {
            this.headerbar = this.get_toplevel().get_titlebar();
            this.headerbar.pack_end(aboutButton);
            this.headerbar.pack_start(this._prevButton);
            return false;
        });
    },

    _connectTemplate: function () {
        // Shell
        this._bind_bool(gsconnect.settings, "show-indicators", this.show_indicators);
        this._bind_bool(gsconnect.settings, "show-offline", this.show_offline);
        this._bind_bool(gsconnect.settings, "show-unpaired", this.show_unpaired);
        this._bind_bool(gsconnect.settings, "show-battery", this.show_battery);
        this.shell_list.set_header_func(this._section_separators);

        // Extensions
        this._bind_bool(gsconnect.settings, "nautilus-integration", this.files_integration);
        this._bind_bool(gsconnect.settings, "webbrowser-integration", this.webbrowser_integration);
        this.extensions_list.set_header_func(this._section_separators);

        // Application Extensions
        this._bind_bool(gsconnect.settings, "debug", this.debug_mode);
        this.debug_window.connect("clicked", () => {
            GLib.spawn_command_line_async(
                'gnome-terminal ' +
                '--tab --title "GJS" --command "journalctl -f -o cat /usr/bin/gjs" ' +
                '--tab --title "Gnome Shell" --command "journalctl -f -o cat /usr/bin/gnome-shell"'
            );
        });
        this.advanced_list.set_header_func(this._section_separators);
    },

    _devicesChanged: function () {
        for (let dbusPath of this.daemon.devices) {
            if (!this.stack.get_child_by_name(dbusPath)) {
                this.addDevice(this.daemon, dbusPath);
            }
        }

        this.stack.foreach((child) => {
            if (child.row) {
                let name = child.row.get_name();
                if (this.daemon.devices.indexOf(name) < 0) {
                    this.stack.get_child_by_name(name).destroy();
                }
            }
        });

        this.help.visible = (!this.daemon.devices.length);
    },

    /**
     * DBus Service Callbacks
     */
    _serviceAppeared: function (conn, name, name_owner) {
        debug([conn, name, name_owner]);

        if (!this.daemon) {
            this.daemon = new Client.Daemon();
        }

        // Watch for new and removed devices
        this.daemon.connect("notify::devices", (daemon) => {
            this._devicesChanged(daemon);
        });
        this._devicesChanged();
    },

    _serviceVanished: function (conn, name) {
        debug([conn, name]);

        if (this.daemon) {
            this.daemon.destroy();
            delete this.daemon;
        }

        this.daemon = new Client.Daemon();
    },

    /**
     * Header Funcs
     */
    _switcher_separators: function (row, before) {
        if (before && row.type !== before.type) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    visible: true
                })
            );
        }
    },

    _section_separators: function (row, before) {
        if (before) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    visible: true
                })
            );
        }
    },

    addDevice: function (daemon, dbusPath) {
        let device = daemon._devices.get(dbusPath);
        let meta = DeviceMetadata[device.type];

        // Separate device settings widgets
        let deviceSettings = new DeviceSettings(daemon, device);
        let switcher = deviceSettings.switcher;
        deviceSettings.remove(deviceSettings.switcher);
        let panel = deviceSettings.stack;
        deviceSettings.remove(deviceSettings.stack);

        // Add panel switcher to sidebar stack
        panel.connect("destroy", () => switcher.destroy());
        this.sidebar.add_named(switcher, dbusPath);

        // Add device panel stack
        this.stack.add_titled(panel, dbusPath, device.name);

        // Add device to sidebar
        panel.row = new SidebarRow({
            icon_name: device.paired ? meta.symbolic_icon : meta.unpaired_icon,
            title: device.name,
            type: "device",
            name: dbusPath,
            go_next: true
        });

        // Destroy the sidebar row when the panel goes
        panel.connect("destroy", () => panel.row.destroy());

        // Keep the icon up to date
        device.connect("notify::paired", () => {
            if (device.paired) {
                panel.row.icon.icon_name = meta.symbolic_icon;
            } else {
                panel.row.icon.icon_name = meta.unpaired_icon;
            }
        });

        this.switcher.add(panel.row);
    }
});


var SectionRow = new Lang.Class({
    Name: "GSConnectSectionRow",
    Extends: Gtk.ListBoxRow,

    _init: function (params) {
        let icon_name = params.icon_name || "";
        delete params.icon_name;
        let title = params.title;
        delete params.title;
        let subtitle = params.subtitle;
        delete params.subtitle;

        params = Object.assign({
            activatable: true,
            selectable: false,
            height_request: 56,
            visible: true
        }, params);
        this.parent(params);

        this.grid = new Gtk.Grid({
            column_spacing: 12,
            margin_top: 8,
            margin_right: 12,
            margin_bottom: 8,
            margin_left: 12,
            visible: true
        });
        this.add(this.grid);

        if (icon_name) {
            this.icon = new Gtk.Image({
                gicon: new Gio.ThemedIcon({
                    names: [ icon_name, "system-run-symbolic" ]
                }),
                pixel_size: 32,
                visible: true
            });

            this.height_request = 56;
            this.grid.attach(this.icon, 0, 0, 1, 2);
        }

        if (title) {
            this.title = new Gtk.Label({
                label: title,
                halign: Gtk.Align.START,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            this.grid.attach(this.title, 1, 0, 1, 1);
        }

        if (subtitle) {
            this.subtitle = new Gtk.Label({
                label: subtitle,
                halign: Gtk.Align.START,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            this.subtitle.get_style_context().add_class("dim-label");
            this.grid.attach(this.subtitle, 1, 1, 1, 1);
        }
    }
});


var KeybindingsSection = new Lang.Class({
    Name: "GSConnectKeybindingsSection",
    Extends: Gtk.Frame,

    _init: function (device) {
        this.parent({
            can_focus: false,
            hexpand: true,
            shadow_type: Gtk.ShadowType.IN,
            visible: true
        });

        this.device = device;

        this.keyView = new KeybindingsWidget.TreeView(
            this.device.settings,
            "keybindings"
        );
        this.add(this.keyView);

        this._setup();
    },

    _reset: function () {
        this.device.settings.set_string("keybindings", "{}");
        this.remove(this.keyView);
        this.keyView.destroy();
        delete this.keyView;

        this.keyView = new KeybindingsWidget.TreeView(
            this.device.settings,
            "keybindings"
        );
        this.add(this.keyView);

        //this.keyView.model.clear();
        this._setup();
    },

    _setup: function () {
        // TRANSLATORS: Open the device menu
        this.keyView.addAccel("menu", _("Open Menu"), 0, 0);
        // TRANSLATORS: Open a new SMS window
        this.keyView.addAccel("sms", _("Send SMS"), 0, 0);
        // TRANSLATORS: eg. Locate Google Pixel
        this.keyView.addAccel("find", _("Locate %s").format(this.device.name), 0, 0);
        // TRANSLATORS: Open the device's list of browseable directories
        this.keyView.addAccel("browse", _("Browse Files"), 0, 0);
        // TRANSLATORS: Open the file chooser for sending files/links
        this.keyView.addAccel("share", _("Share File/URL"), 0, 0);

        this.keyView.setAccels(
            JSON.parse(this.device.settings.get_string("keybindings"))
        );
    }
});


const AllowTraffic = {
    OFF: 1,
    OUT: 2,
    IN: 4
};


var DeviceSettings = Lang.Class({
    Name: "GSConnectDeviceSettings",
    Extends: Gtk.Grid,
    Template: "resource:///org/gnome/Shell/Extensions/GSConnect/device.ui",
    Children: [
        "stack", "switcher",
        // Device
        "device-status-list",
        "device-icon", "device-name", "device-type",
        "battery-level", "battery-percent", "battery-condition",
        "device-connected", "device-connected-text",
        "device-paired", "device-paired-text",
        // Commands
        "commands", "runcommand-local-list", "runcommand-remote-list",
        "command-edit", "command-edit-icon", "command-edit-name", "command-edit-command",
        "command-edit-cancel", "command-edit-apply",
        // Notifications
        "notification", "notification-page",
        "send-notifications", "notification-apps",
        // Sharing
        "sharing", "sharing-page", "sharing-list",
        "battery-allow", "direct-sharing", "clipboard-allow", "mpris-control",
        "allow-input",
        // Telephony
        "telephony", "telephony-page",
        "handler-list", "handle-messaging", "handle-calls",
        "ringing-list", "ringing-volume", "ringing-pause",
        "talking-list", "talking-volume", "talking-pause", "talking-microphone"
    ],

    _init: function (daemon, device) {
        this.parent();

        this.daemon = daemon;
        this.device = device;

        this.switcher.connect("row-selected", (box, row) => {
            this.stack.set_visible_child_name(row.get_name());
        });

        this._infoPage();
        this._batterySettings();
        this._runcommandSettings();
        this._notificationSettings();
        this._sharingSettings();
        this._telephonySettings();
    },

    _sectionSeparators: function (row, before) {
        if (before) {
            row.set_header(
                new Gtk.Separator({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    visible: true
                })
            );
        }
    },

    _mapBool: function (obj, key, label, [on, off]=[true, false]) {
        let row = label.get_parent().get_parent();

        if (obj && obj.settings) {
            let variant = obj.settings.get_value(key);
            let format = variant.get_type_string();

            // Init the label
            label.label = (variant.unpack() === on) ? _("On") : _("Off");

            // Watch the setting for changes
            let _changed = obj.settings.connect("changed::" + key, (settings) => {
                let variant = obj.settings.get_value(key);
                label.label = (variant.unpack() === on) ? _("On") : _("Off");
            });
            label.connect("destroy", () => obj.settings.disconnect(_changed));

            // Watch the Gtk.ListBox for activation
            row.get_parent().connect("row-activated", (box, arow) => {
                if (row === arow) {
                    // Set the boolean to the inverse of the label "value"
                    let variant = new GLib.Variant(
                        format,
                        (label.label === _("Off")) ? on : off
                    );
                    obj.settings.set_value(key, variant);
                }
            });
        } else {
            row.visible = false;
        }
    },

    _mapNumber: function (obj, key, label, map=[]) {
        let row = label.get_parent().get_parent();

        if (obj && obj.settings) {
            // Init the label
            label.label = map[obj.settings.get_uint(key)];
            // Watch settings for changes
            let _changed = obj.settings.connect("changed::" + key, (settings) => {
                label.label = map[obj.settings.get_uint(key)];
            });
            label.connect("destroy", () => obj.settings.disconnect(_changed));
            obj.settings.emit("changed::" + key, key);

            // Watch the Gtk.ListBox for activation
            let lastIndex = map.length - 1;

            row.get_parent().connect("row-activated", (box, arow) => {
                if (row === arow) {
                    let flags = obj.settings.get_uint(key);
                    let next = map.slice(flags + 1).filter(e => e)[0];
                    obj.settings.set_uint(key, (next) ? map.indexOf(next) : 1);
                }
            });
        } else {
            row.visible = false;
        }
    },

    _mapTraffic: function (obj, key, label) {
        let map = [];
        map[1] = _("Off");
        map[2] = _("Out");
        map[4] = _("In");
        map[6] = _("Both");

        return this._mapNumber(obj, key, label, map);
    },

    /**
     * Info Page
     */
    _infoPage: function () {
        let meta = DeviceMetadata[this.device.type]
        this.device_name.label = "<big><b>" + this.device.name + "</b></big>";
        this.device_type.label = meta.type;
        this.device_icon.icon_name = meta.icon;

        // Connected
        let connectedRow = this.device_connected.get_parent().get_parent();
        connectedRow.get_parent().connect("row-activated", (box, arow) => {
            if (connectedRow === arow && !this.device.connected) {
                this.device.activate();
            }
        });

        this.device.connect("notify::connected", () => {
            let [on, off] = ["emblem-ok-symbolic", "emblem-synchronizing-symbolic"];

            if (this.device.connected) {
                this.device_connected.icon_name = on;
                this.device_connected_text.label = _("Device is connected");
                connectedRow.set_tooltip_markup(null);
            } else {
                this.device_connected.icon_name = off;
                this.device_connected_text.label = _("Device is disconnected");
                connectedRow.set_tooltip_markup(
                    // TRANSLATORS: eg. Reconnect <b>Google Pixel</b>
                    _("Reconnect <b>%s</b>").format(this.device.name)
                );

                let pairedRow = this.device_paired.get_parent().get_parent();
                pairedRow.sensitive = this.device.paired;
            }
        });
        this.device.notify("connected");


        // Paired
        let pairedRow = this.device_paired.get_parent().get_parent();
        pairedRow.get_parent().connect("row-activated", (box, arow) => {
            if (pairedRow === arow) {
                if (this.device.paired) {
                    this.device.unpair();
                } else {
                    this.device.pair();
                }
            }
        });
        this.device.connect("notify::paired", () => {
            let [on, off] = ["emblem-ok-symbolic", "emblem-synchronizing-symbolic"];

            if (this.device.paired) {
                this.device_paired.icon_name = "channel-secure-symbolic";
                this.device_paired_text.label = _("Device is paired");
                pairedRow.set_tooltip_markup(
                    // TRANSLATORS: eg. Unpair <b>Google Pixel</b>
                    _("Unpair <b>%s</b>").format(this.device.name)
                );
                pairedRow.sensitive = true;
            } else {
                this.device_paired.icon_name = "channel-insecure-symbolic";
                this.device_paired_text.label = _("Device is unpaired");
                pairedRow.set_tooltip_markup(
                    // TRANSLATORS: eg. Pair <b>Google Pixel</b>
                    _("Pair <b>%s</b>").format(this.device.name) + "\n\n" +
                    // TRANSLATORS: Remote and local TLS Certificate fingerprint
                    // PLEASE KEEP NEWLINE CHARACTERS (\n)
                    //
                    // Example:
                    //
                    // <b>Google Pixel Fingerprint:</b>
                    // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
                    //
                    // <b>Local Fingerprint:</b>
                    // 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
                    _("<b>%s Fingerprint:</b>\n%s\n\n<b>Local Fingerprint:</b>\n%s").format(this.device.name, this.device.fingerprint, this.daemon.fingerprint)
                );
                pairedRow.sensitive = this.device.connected;
            }
        });
        this.device.notify("paired");
        this.device_status_list.set_header_func(this._sectionSeparators);
    },

    /**
     * Battery Settings
     */
    _batterySettings: function () {
        let battery = this.device._plugins.get("battery");

        if (battery) {
            this.battery_level.get_style_context().add_class("battery-bar");

            battery.connect("notify", (plugin) => {
                let level = battery.level;

                this.battery_level.visible = (level > -1);
                this.battery_condition.visible = (level > -1);
                this.battery_percent.visible = (level > -1);

                if (level > -1) {
                    this.battery_level.value = level;
                    this.battery_percent.label = _("%d%%").format(level);

                    if (battery.charging) {
                        this.battery_condition.label = _("Charging...");
                    } else if (level < 10) {
                        this.battery_condition.label = _("Caution");
                    } else if (level < 30) {
                        this.battery_condition.label = _("Low");
                    } else if (level < 60) {
                        this.battery_condition.label = _("Good");
                    } else if (level >= 60) {
                        this.battery_condition.label = _("Full");
                    }
                }

            });
            battery.notify("level");
        }
    },

    _runcommandSettings: function () {
        let runcommand = this.device._plugins.get("runcommand");

        if (runcommand) {
            // Edit Command dialog
            this.command_edit_name.connect("changed", () => {
                this.command_edit_icon.gicon = new Gio.ThemedIcon({
                    names: [
                        this.command_edit_name.text.toLowerCase(),
                        "application-x-executable"
                    ]
                });
            });
            this.command_edit_name.connect("activate", () => this._applyCommand());
            this.command_edit_command.connect("icon-release", () => this._openCommand());
            this.command_edit_command.connect("activate", () => this._applyCommand());
            this.command_edit_cancel.connect("clicked", () => this._cancelCommand());
            this.command_edit_apply.connect("clicked", () => this._applyCommand());

            // Local Command List
            let commands = runcommand.settings.get_string("command-list");
            this._commands = JSON.parse(commands);

            this.runcommand_local_list.set_sort_func((row1, row2) => {
                if (row1.get_child() instanceof Gtk.Image) {
                    return 1;
                } else if (row2.get_child() instanceof Gtk.Image) {
                    return -1;
                } else if (row1.uuid && row1.uuid === row2.get_name()) {
                    return 1;
                } else if (row2.uuid && row2.uuid === row1.get_name()) {
                    return -1;
                } else if (!row1.title || !row2.title) {
                    return 0;
                }

                return row1.title.label.localeCompare(row2.title.label);
            });
            this.runcommand_local_list.set_header_func(this._sectionSeparators);
            this._populateCommands();
        } else {
            this.commands.visible = false;
        }
    },

    _populateCommands: function () {
        this.runcommand_local_list.foreach((row) => {
            if (["add-command", "command-edit"].indexOf(row.get_name()) < 0) {
                row.destroy();
            }
        });

        for (let uuid in this._commands) {
            let row = new SectionRow({
                icon_name: this._commands[uuid].name.toLowerCase(),
                title: this._commands[uuid].name,
                subtitle: this._commands[uuid].command
            });
            row.set_name(uuid);

            row.cmdRemove = new Gtk.Button({
                image: new Gtk.Image({
                    icon_name: "document-edit-symbolic",
                    pixel_size: 16,
                    visible: true
                }),
                halign: Gtk.Align.END,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            row.cmdRemove.get_style_context().add_class("circular");
            row.cmdRemove.get_style_context().add_class("flat");
            row.cmdRemove.connect("clicked", () => this._editCommand(row, uuid));
            row.grid.attach(row.cmdRemove, 2, 0, 1, 2);

            this.runcommand_local_list.add(row);
        }
    },

    _applyCommand: function () {
        let cmd = this._commands[this.command_edit.uuid];
        cmd.name = this.command_edit_name.text.slice(0);
        cmd.command = this.command_edit_command.text.slice(0);

        this.device._plugins.get("runcommand").settings.set_string(
            "command-list",
            JSON.stringify(this._commands)
        );

        this._populateCommands();
        this._cancelCommand();
    },

    _cancelCommand: function () {
        delete this.command_edit.title;
        this.command_edit_name.text = "";
        this.command_edit_command.text = "";

        this.runcommand_local_list.foreach((row) => {
            if (row.get_name() === this.command_edit.uuid) {
                row.visible = true;
            }
        });
        delete this.command_edit.uuid;

        this.command_edit.visible = false;
        this.runcommand_local_list.invalidate_sort();
    },

    _editCommand: function (row, uuid) {
        this.command_edit.uuid = uuid;
        this.command_edit_name.text = this._commands[uuid].name.slice(0);
        this.command_edit_command.text = this._commands[uuid].command.slice(0);

        this.command_edit.title = { label: this.command_edit_name.text };
        this.runcommand_local_list.foreach((row) => {
            if (row.get_name() === uuid) {
                row.visible = false;
            }
        });

        this.command_edit.visible = true;
        this.runcommand_local_list.invalidate_sort();
    },

    _openCommand: function () {
        if (pos === Gtk.EntryIconPosition.SECONDARY) {
            let filter = new Gtk.FileFilter();
            filter.add_mime_type("application/x-executable");
            let dialog = new Gtk.FileChooserDialog({ filter: filter });
            dialog.add_button(_("Cancel"), Gtk.ResponseType.CANCEL);
            dialog.add_button(_("Open"), Gtk.ResponseType.OK);

            if (dialog.run() === Gtk.ResponseType.OK) {
                this.command_edit_command.text = dialog.get_filename();
            }

            dialog.destroy();
        }
    },

    /**
     * Notification Settings
     */
    _notificationSettings: function () {
        let notification = this.device._plugins.get("notification");

        if (notification) {
            notification.settings.bind(
                "send-notifications",
                this.send_notifications,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            this._populateApplications(notification);
            this.notification_apps.set_sort_func((row1, row2) => {
                return row1.title.label.localeCompare(row2.title.label);
            });
            this.notification_apps.set_header_func(this._sectionSeparators);
            this.notification_apps.connect("row-activated", (box, row) => {
                if (row.enabled.label === _("On")) {
                    this._notification_apps[row.appName.label].enabled = false;
                    row.enabled.label = _("Off")
                } else {
                    this._notification_apps[row.appName.label].enabled = true;
                    row.enabled.label = _("On")
                }
                notification.settings.set_string(
                    "applications",
                    JSON.stringify(this._notification_apps)
                );
            });
            notification.settings.bind(
                "send-notifications",
                this.notification_apps,
                "sensitive",
                Gio.SettingsBindFlags.DEFAULT
            );
        } else {
            this.notification.visible = false;
            this.notification_page.visible = false;
        }
    },

    _populateApplications: function (notification) {
        let applications = this._queryApplications(notification);

        for (let name in this._notification_apps) {
            let row = new SectionRow({
                icon_name: this._notification_apps[name].iconName,
                title: name,
                height_request: 48
            });

            row.enabled = new Gtk.Label({
                label: this._notification_apps[name].enabled ? _("On") : _("Off"),
                margin_end: 12,
                halign: Gtk.Align.END,
                hexpand: true,
                valign: Gtk.Align.CENTER,
                vexpand: true,
                visible: true
            });
            row.grid.attach(row.enabled, 2, 0, 1, 1);

            this.notification_apps.add(row);
        }
    },

    _queryApplications: function (notification) {
        let applications = notification.settings.get_string("applications");
        this._notification_apps = JSON.parse(applications);

        // Query Gnome's notification settings
        let desktopSettings = new Gio.Settings({
            schema_id: "org.gnome.desktop.notifications"
        });

        for (let app of desktopSettings.get_strv("application-children")) {
            let appSettings = new Gio.Settings({
                schema_id: "org.gnome.desktop.notifications.application",
                path: "/org/gnome/desktop/notifications/application/" + app + "/"
            });

            let appInfo = Gio.DesktopAppInfo.new(
                appSettings.get_string("application-id")
            );

            if (appInfo) {
                let name = appInfo.get_name();

                if (!this._notification_apps[name]) {
                    this._notification_apps[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }

        // Include applications that statically declare to show notifications
        for (let appInfo of Gio.AppInfo.get_all()) {
            if (appInfo.get_boolean("X-GNOME-UsesNotifications")) {
                let name = appInfo.get_name();

                if (!this._notification_apps[name]) {
                    this._notification_apps[name] = {
                        iconName: appInfo.get_icon().to_string(),
                        enabled: true
                    };
                }
            }
        }

        notification.settings.set_string(
            "applications",
            JSON.stringify(this._notification_apps)
        );

        return applications;
    },

    /**
     * Sharing Settings
     */
    _sharingSettings: function () {
        // Battery
        if (this.device.incomingCapabilities.indexOf("kdeconnect.battery") > -1) {
            let battery = this.device._plugins.get("battery");
            this._mapBool(battery, "allow", this.battery_allow, [ 2, 4 ]);
        } else {
            this.battery_allow.get_parent().get_parent().visible = false;
        }

        // Direct Share
        let share = this.device._plugins.get("share");
        this._mapBool(share, "direct-sharing", this.direct_sharing);

        // Clipboard Sync
        let clipboard = this.device._plugins.get("clipboard");
        this._mapTraffic(clipboard, "allow", this.clipboard_allow);

        // Media Players
        let mpris = this.device._plugins.get("mpris");
        this._mapBool(mpris, "mpris-control", this.mpris_control);

        // Mouse & Keyboard input
        let mousepad = this.device._plugins.get("mousepad");
        this._mapBool(mousepad, "allow-input", this.allow_input);

        // Location Sharing
//        let findmyphone = this.device._plugins.get("findmyphone");
//        this._mapBool(findmyphone, "allow-locate", this.allow_locate);

        // row separators
        this.sharing_list.set_header_func(this._sectionSeparators);

//        this.sharing_list.set_sort_func((row1, row2) => {
//            return row1.appName.label.localeCompare(row2.appName.label);
//        });
    },

    /**
     * Telephony Settings
     */
    _telephonySettings: function () {
        let telephony = this.device._plugins.get("telephony");

        if (telephony) {
            // Event Handling
            this._mapBool(telephony, "handle-messaging", this.handle_messaging);
            this._mapBool(telephony, "handle-calls", this.handle_calls);
            this.handler_list.set_header_func(this._sectionSeparators);

            // Ringing Event
            telephony.settings.bind(
                "ringing-volume",
                this.ringing_volume,
                "active-id",
                Gio.SettingsBindFlags.DEFAULT
            );
            telephony.settings.bind(
                "ringing-pause",
                this.ringing_pause,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            this.ringing_list.set_header_func(this._sectionSeparators);

            // Talking Event
            telephony.settings.bind(
                "talking-volume",
                this.talking_volume,
                "active-id",
                Gio.SettingsBindFlags.DEFAULT
            );
            telephony.settings.bind(
                "talking-microphone",
                this.talking_microphone,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            telephony.settings.bind(
                "talking-pause",
                this.talking_pause,
                "active",
                Gio.SettingsBindFlags.DEFAULT
            );
            this.talking_list.set_header_func(this._sectionSeparators);
        } else {
            this.telephony.visible = false;
            this.telephony_page.visible = false;
        }

        //
        if (this.device.plugins.indexOf("mpris") < 0) {
            this.ringing_pause.sensitive = false;
            this.ringing_pause.set_tooltip_markup(
                _("MPRIS not supported")
            );

            this.talking_pause.sensitive = false;
            this.talking_pause.set_tooltip_markup(
                _("MPRIS not supported")
            );
        }

        //
        if (!Sound._mixerControl) {
            this.ringing_volume.sensitive = false;
            this.ringing_volume.set_tooltip_markup(_("Gvc not available"));

            this.talking_volume.sensitive = false;
            this.talking_volume.set_tooltip_markup(_("Gvc not available"));

            this.talking_microphone.sensitive = false;
            this.talking_microphone.set_tooltip_markup(_("Gvc not available"));
        }
    }
});


var DeviceMetadata = {
    desktop: {
        type: _("Desktop"),
        icon: "computer",
        symbolic_icon: "computer-symbolic",
        unpaired_icon: "desktopdisconnected"
    },
    laptop: {
        type: _("Laptop"),
        icon: "laptop",
        symbolic_icon: "laptop-symbolic",
        unpaired_icon: "laptopdisconnected"
    },
    phone: {
        type: _("Smartphone"),
        icon: "phone",
        symbolic_icon: "smartphone-symbolic",
        unpaired_icon: "smartphonedisconnected"
    },
    tablet: {
        type: _("Tablet"),
        icon: "tablet",
        symbolic_icon: "tablet-symbolic",
        unpaired_icon: "tabletdisconnected"
    },
    unknown: {
        type: _("Unknown"),
        icon: "computer",
        symbolic_icon: "computer-symbolic",
        unpaired_icon: "desktopdisconnected"
    }
};
