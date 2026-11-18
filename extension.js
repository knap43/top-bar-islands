import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BMS_UUID = 'blur-my-shell@aunetx';
const BMS_PANEL_SCHEMA = 'org.gnome.shell.extensions.blur-my-shell.panel';
// Blur my Shell's full-width blur behind the panel, which would show between the islands.
const BMS_STRIP_NAME = 'bms-panel-backgroundgroup';
const BMS_REBUILD_KEYS = ['blur', 'pipeline', 'pipeline-auto-mode', 'pipeline-dark', 'pipeline-light'];

const PANEL_CLASS = 'top-bar-islands';
const BLURRED_CLASS = 'top-bar-islands-blurred';
const ISLAND_CLASS = 'top-bar-island';
// Larger than half any island's height, so both St and Blur my Shell round it into a pill.
const PILL_RADIUS = 999;

export default class TopBarIslands extends Extension {
    enable() {
        this._panel = Main.panel;
        this._panelBox = Main.layoutManager.panelBox;
        this._islands = [this._panel._leftBox, this._panel._centerBox, this._panel._rightBox];
        this._signals = [];
        this._pipelines = [];
        this._generation = 0;
        this._blurring = false;
        this._bmsSettings = null;
        this._bmsSettingsId = 0;

        this._panel.add_style_class_name(PANEL_CLASS);
        this._islands.forEach(island => island.add_style_class_name(ISLAND_CLASS));

        // A zero-sized group at the bottom of the panel box, as Blur my Shell uses for its own
        // blur: it takes no room in the box, and its children paint beneath the panel.
        this._backdrop = new Clutter.Actor({name: 'top-bar-islands-backdrop', width: 0, height: 0});
        this._panelBox.insert_child_at_index(this._backdrop, 0);
        this._backs = this._islands.map(() => {
            const back = new St.Widget({reactive: false, visible: false});
            this._backdrop.add_child(back);
            return back;
        });

        this._islands.forEach((island, i) =>
            this._connect(island, 'notify::allocation', () => this._syncBack(i)));
        this._connect(this._panel, 'notify::allocation', () => this._syncBacks());
        this._connect(this._panelBox, 'child-added', (_box, child) => {
            if (child.name === BMS_STRIP_NAME)
                this._hideStrip(child);
        });
        this._connect(Main.extensionManager, 'extension-state-changed', (_manager, extension) => {
            if (extension.uuid === BMS_UUID)
                this._rebuildBlur();
        });
        this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._connect(this._interfaceSettings, 'changed::color-scheme', () => this._rebuildBlur());

        this._watchWorkspaceDots();
        this._findStrip();
        this._rebuildBlur();
    }

    disable() {
        this._generation++;
        this._destroyPipelines();
        this._watchBmsSettings(null);
        this._unwatchWorkspaceDots();
        this._signals.forEach(([object, id]) => object.disconnect(id));
        this._signals = [];
        this._interfaceSettings = null;

        this._backdrop.destroy();
        this._backdrop = null;
        this._backs = null;

        this._islands.forEach(island => island.remove_style_class_name(ISLAND_CLASS));
        this._panel.remove_style_class_name(PANEL_CLASS);
        this._panel.remove_style_class_name(BLURRED_CLASS);
        this._showStrip();

        this._islands = null;
        this._panel = null;
        this._panelBox = null;
    }

    // GNOME grows each new workspace dot from nothing. If that animation is stopped part-way, as
    // can happen while the panel is being restyled at login, the dot keeps its partial scale for
    // the rest of the session. Any dot left so, neither animating nor being removed, is finished.
    _watchWorkspaceDots() {
        this._healId = 0;
        this._indicators = this._panel.statusArea.activities?.get_children()
            .find(child => child.constructor.name === 'WorkspaceIndicators') ?? null;
        if (!this._indicators)
            return;

        const watch = dot => dot.connectObject('transition-stopped', (_dot, name, finished) => {
            if (!finished && name.startsWith('scale'))
                this._queueDotHeal();
        }, this);
        this._indicators.get_children().forEach(watch);
        this._indicators.connectObject('child-added', (_indicators, dot) => watch(dot), this);
        this._queueDotHeal();
    }

    _unwatchWorkspaceDots() {
        if (this._healId)
            GLib.source_remove(this._healId);
        this._healId = 0;
        this._indicators?.get_children().forEach(dot => dot.disconnectObject(this));
        this._indicators?.disconnectObject(this);
        this._indicators = null;
    }

    // Deferred, so that an animation replacing the stopped one has started by the time we look.
    _queueDotHeal() {
        if (this._healId)
            return;
        this._healId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._healId = 0;
            for (const dot of this._indicators?.get_children() ?? []) {
                if (dot.destroying || dot.get_transition('scale-x') || dot.get_transition('scale-y'))
                    continue;
                if (dot.scale_x !== 1 || dot.scale_y !== 1)
                    dot.set({scale_x: 1, scale_y: 1});
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _syncBacks() {
        this._islands.forEach((_island, i) => this._syncBack(i));
    }

    // Lays a blur surface exactly under an island. The island's allocation already excludes
    // its CSS margins, so it is the pill's own rectangle, in the panel's coordinates.
    _syncBack(i) {
        const island = this._islands[i];
        const back = this._backs[i];
        const box = island.get_allocation_box();
        const panel = this._panel.get_allocation_box();
        const width = box.get_width();
        const height = box.get_height();

        back.set_position(panel.x1 + box.x1, panel.y1 + box.y1);
        back.set_size(Math.max(1, width), Math.max(1, height));
        back.visible = this._blurring && island.visible && width > 0 && height > 0;
    }

    _setBlurring(blurring) {
        this._blurring = blurring;
        if (blurring)
            this._panel.add_style_class_name(BLURRED_CLASS);
        else
            this._panel.remove_style_class_name(BLURRED_CLASS);
        this._syncBacks();
    }

    // Blur my Shell's strip stays hidden while the islands are shown, whether or not they are
    // blurred: across the gaps between them it would look like a second bar.
    _findStrip() {
        const strip = this._panelBox.get_children().find(child => child.name === BMS_STRIP_NAME);
        if (strip)
            this._hideStrip(strip);
    }

    _hideStrip(strip) {
        this._strip = strip;
        strip.hide();
        strip.connectObject('destroy', () => {
            if (this._strip === strip)
                this._strip = null;
        }, this);
    }

    _showStrip() {
        this._strip?.disconnectObject(this);
        this._strip?.show();
        this._strip = null;
    }

    // Blurs each island with Blur my Shell's own dynamic pipeline, the one it uses for the panel,
    // so the islands follow its blur settings and round their corners as it rounds its own.
    async _rebuildBlur() {
        const generation = ++this._generation;
        this._destroyPipelines();

        const bms = Main.extensionManager.lookup(BMS_UUID);
        const shared = global.blur_my_shell;
        if (!bms || !shared?._pipelines_manager || !shared._effects_manager) {
            this._watchBmsSettings(null);
            this._setBlurring(false);
            return;
        }
        this._watchBmsSettings(bms);

        if (!shared._settings?.panel?.BLUR) {
            this._setBlurring(false);
            return;
        }

        try {
            const base = bms.dir.get_uri();
            const [{DynamicPipeline}, {get_pipeline_id}] = await Promise.all([
                import(`${base}/render/dynamic_surface.js`),
                import(`${base}/conveniences/style.js`),
            ]);
            if (generation !== this._generation)
                return;

            this._pipelines = this._backs.map(back => {
                const pipeline = new DynamicPipeline(
                    shared._effects_manager,
                    shared._pipelines_manager,
                    get_pipeline_id(shared._settings.panel),
                    {corner_radius: PILL_RADIUS, get_corners: () => 0}
                );
                pipeline.attach_to_container(back, 'top-bar-islands-blurred-widget');
                return pipeline;
            });
            this._setBlurring(true);
        } catch (e) {
            console.warn(`Top Bar Islands: could not use Blur my Shell's blur: ${e}`);
            this._destroyPipelines();
            this._setBlurring(false);
        }
    }

    _destroyPipelines() {
        this._pipelines.forEach(pipeline => {
            try {
                pipeline.destroy();
            } catch (e) {
                console.warn(`Top Bar Islands: could not tear down a blur: ${e}`);
            }
        });
        this._pipelines = [];
    }

    _watchBmsSettings(bms) {
        if (bms && this._bmsSettings)
            return;
        if (this._bmsSettingsId)
            this._bmsSettings.disconnect(this._bmsSettingsId);
        this._bmsSettings = null;
        this._bmsSettingsId = 0;
        if (!bms?.stateObj?.getSettings)
            return;

        try {
            this._bmsSettings = bms.stateObj.getSettings(BMS_PANEL_SCHEMA);
            this._bmsSettingsId = this._bmsSettings.connect('changed', (_settings, key) => {
                if (BMS_REBUILD_KEYS.includes(key))
                    this._rebuildBlur();
            });
        } catch (e) {
            this._bmsSettings = null;
        }
    }
}
