<template>
  <div class="mx-auto max-w-6xl p-6">
    <div class="mb-4 flex items-center">
      <h2 class="text-xl font-semibold tracking-tight">Tree</h2>
      <span v-if="selectionCount" class="ml-3 rounded-md bg-muted px-1.5 py-0.5 text-xs">
        {{ selectionCount }} selected
      </span>
      <span
        v-if="savedCount && savedCount !== selectionCount"
        class="ml-1 rounded-md border px-1.5 py-0.5 text-xs"
      >
        {{ savedCount }} saved
      </span>
      <div class="flex-1"></div>
      <button
        v-if="selectionCount"
        class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm hover:bg-accent rounded-md"
        @click="clearSelection"
      >
        <XCircle class="h-4 w-4" />
        Clear
      </button>
      <button
        :disabled="!hasChanges || saving"
        class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm hover:bg-accent rounded-md disabled:opacity-40 disabled:hover:bg-transparent"
        @click="saveSelection"
      >
        <Save class="h-4 w-4" :class="saving ? 'animate-pulse' : ''" />
        Save
      </button>
      <button
        :disabled="!selectionCount || importing"
        class="ml-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        @click="importSelected(false)"
      >
        <DownloadCloud class="h-4 w-4" :class="importing ? 'animate-pulse' : ''" />
        Import
      </button>
      <button
        class="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-sm hover:bg-accent rounded-md disabled:opacity-50"
        :disabled="resettingCache"
        title="Drop cached Desigo discovery results. Next expand will refetch."
        @click="resetCache"
      >
        <Database class="h-4 w-4" :class="resettingCache ? 'animate-pulse' : ''" />
        Reset cache
      </button>
      <button
        class="ml-2 rounded-md p-1.5 hover:bg-accent disabled:opacity-50"
        :disabled="loading"
        @click="reload"
      >
        <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" />
      </button>
    </div>

    <div
      v-if="importing"
      class="mb-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <div class="flex items-start gap-2">
        <Loader2 class="h-4 w-4 mt-0.5 shrink-0 animate-spin text-primary" />
        <div class="flex-1 font-mono text-xs">{{ importStatus || "Starting…" }}</div>
      </div>
    </div>
    <div
      v-if="error"
      class="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <div class="flex items-start gap-2">
        <AlertCircle class="h-4 w-4 mt-0.5 shrink-0" />
        <div class="flex-1">{{ error }}</div>
        <button class="opacity-60 hover:opacity-100" @click="error = ''"><X class="h-4 w-4" /></button>
      </div>
    </div>
    <div
      v-if="info"
      class="mb-3 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700"
    >
      <div class="flex items-start gap-2">
        <CheckCircle class="h-4 w-4 mt-0.5 shrink-0" />
        <div class="flex-1">{{ info }}</div>
        <button class="opacity-60 hover:opacity-100" @click="info = ''"><X class="h-4 w-4" /></button>
      </div>
    </div>

    <div v-if="!loading && !rootViews.length" class="text-sm text-muted-foreground">
      No views selected. Go to <span class="font-medium">Settings</span> and pick one or more views to explore.
    </div>

    <div
      v-for="view in rootViews"
      :key="view.SystemId + ':' + view.ViewId"
      class="mb-3 rounded-lg border bg-card shadow-sm overflow-hidden"
    >
      <div class="flex items-center px-4 py-2.5 border-b">
        <LayoutGrid class="h-4 w-4 mr-2 text-muted-foreground" />
        <span class="text-sm font-semibold">{{ view.Descriptor || view.Name }}</span>
        <span class="ml-2 text-xs text-muted-foreground">
          {{ view.SystemName }} / {{ view.Designation }}
        </span>
      </div>
      <div class="p-1.5">
        <tree-node
          :node="viewRootNode(view)"
          :system-id="view.SystemId"
          :view-id="view.ViewId"
          :depth="0"
          :selection="selection"
          @select="onSelect"
        />
      </div>
    </div>

    <!-- Import result modal (custom; no radix dependency) -->
    <div v-if="resultDialog" class="fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="resultDialog = false">
      <div class="absolute inset-0 bg-black/40"></div>
      <div class="relative bg-card rounded-lg shadow-xl w-full max-w-md focus:outline-none">
        <div class="flex items-center gap-2 px-5 pt-5 pb-2">
          <AlertCircle v-if="resultError" class="h-5 w-5 text-destructive" />
          <CheckCircle2 v-else class="h-5 w-5 text-emerald-600" />
          <h3 class="text-base font-semibold">
            {{ resultError ? "Import failed" : (resultDryRun ? "Dry run" : "Import complete") }}
          </h3>
        </div>
        <div class="border-t"></div>
        <div class="px-5 py-4">
          <div v-if="resultError" class="text-sm text-destructive">{{ resultError }}</div>
          <ul v-else class="space-y-1.5 text-sm">
            <li v-for="(v, k) in resultCounts" :key="k" class="flex justify-between">
              <span class="text-muted-foreground">{{ labelFor(k) }}</span>
              <span class="font-medium">{{ v }}</span>
            </li>
          </ul>
        </div>
        <div class="border-t"></div>
        <div class="flex justify-end px-5 py-3">
          <button class="inline-flex items-center rounded-md border bg-background px-3 py-1.5 text-sm hover:bg-accent" @click="resultDialog = false">
            Close
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import treeNode from "./tree-node.vue";
import {
  AlertCircle,
  Database,
  Loader2,
  CheckCircle,
  CheckCircle2,
  DownloadCloud,
  LayoutGrid,
  RefreshCw,
  Save,
  X,
  XCircle,
} from "lucide-vue-next";

const discover = window.NF.discover;
const importSelectedApi = window.NF.importSelected;

const COUNT_LABELS = {
  walked: "Nodes walked",
  unique: "Unique nodes",
  afterDisciplineFilter: "After discipline filter",
  afterObjectTypeFilter: "After object-type filter",
  propertyRecords: "Property records fetched",
  pointsBuilt: "Points built",
  pointsInserted: "Points inserted",
  dryRun: "Dry run",
};

export default {
  components: {
    "tree-node": treeNode,
    AlertCircle, CheckCircle, CheckCircle2, Database, DownloadCloud, LayoutGrid, Loader2, RefreshCw, Save, X, XCircle,
  },
  data: () => ({
    rootViews: [],
    resettingCache: false,
    selectedViewIds: [],
    selection: new Map(),
    selectionCount: 0,
    savedSelection: new Set(),
    loading: false,
    saving: false,
    importing: false,
    importStatus: "",
    error: "",
    info: "",
    resultDialog: false,
    resultError: "",
    resultCounts: {},
    resultDryRun: false,
    AlertCircle, CheckCircle2,
  }),
  computed: {
    savedCount() { return this.savedSelection.size; },
    hasChanges() {
      if (this.selection.size !== this.savedSelection.size) return true;
      for (const d of this.selection.keys()) {
        if (!this.savedSelection.has(d)) return true;
      }
      return false;
    },
  },
  async mounted() { await this.reload(); },
  methods: {
    viewRootNode(v) {
      return {
        Name: v.Name,
        Descriptor: v.Descriptor,
        Designation: v.Designation,
        ObjectId: v.Designation,
        HasChild: true,
        Attributes: {},
      };
    },
    labelFor(k) { return COUNT_LABELS[k] || k; },
    async reload() {
      this.loading = true; this.error = "";
      try {
        const cfg = await discover.loadConfig();
        const c = cfg.config || {};
        const sel = c.selectedViews || [];
        this.selectedViewIds = sel;
        const nodes = c.selectedNodes || [];
        const map = new Map();
        for (const n of nodes) {
          if (!n || !n.designation) continue;
          map.set(n.designation, {
            systemId: Number(n.systemId),
            viewId: Number(n.viewId),
            designation: n.designation,
          });
        }
        this.selection = map;
        this.selectionCount = map.size;
        this.savedSelection = new Set(map.keys());
        if (!sel.length) { this.rootViews = []; return; }
        const r = await discover.listViews();
        const all = (r && r.views) || [];
        this.rootViews = all.filter((v) =>
          sel.some((s) => s.systemId === v.SystemId && s.viewId === v.ViewId)
        );
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
    },
    onSelect({ systemId, viewId, designation, on }) {
      if (!designation) return;
      const next = new Map(this.selection);
      if (on) next.set(designation, { systemId, viewId, designation });
      else next.delete(designation);
      this.selection = next;
      this.selectionCount = next.size;
    },
    clearSelection() { this.selection = new Map(); this.selectionCount = 0; },
    async resetCache() {
      if (this.resettingCache) return;
      if (!confirm("Drop cached Desigo discovery results? The next tree expand will refetch from Desigo (slower).")) return;
      this.resettingCache = true;
      this.error = ""; this.info = "";
      try {
        const r = await window.NF.discover.resetCache();
        this.info = `Cache cleared (${(r && r.removed) || 0} file${(r && r.removed) === 1 ? "" : "s"}). Refreshing tree…`;
        await this.reload();
      } catch (e) {
        this.error = "reset_cache: " + e.message;
      } finally {
        this.resettingCache = false;
      }
    },
    async saveSelection() {
      this.saving = true; this.error = ""; this.info = "";
      try {
        const selectedNodes = Array.from(this.selection.values());
        await discover.saveConfig({ selectedNodes });
        this.savedSelection = new Set(this.selection.keys());
        this.info = `Saved ${selectedNodes.length} selection${selectedNodes.length === 1 ? "" : "s"}.`;
      } catch (e) { this.error = "save: " + e.message; }
      finally { this.saving = false; }
    },
    async importSelected(dryRun) {
      this.importing = true; this.importStatus = "Starting…";
      this.error = ""; this.info = "";
      this.resultError = ""; this.resultCounts = {}; this.resultDryRun = !!dryRun;
      try {
        if (this.hasChanges) await this.saveSelection();
        const r = await importSelectedApi(
          dryRun ? { dryRun: "true" } : {},
          (events /*, state */) => {
            // events[0] is the most recent — show it verbatim.
            if (events && events.length) this.importStatus = events[0].message;
          }
        );
        const out = {};
        for (const k of [
          "walked","unique","afterDisciplineFilter","afterObjectTypeFilter",
          "propertyRecords","pointsBuilt","pointsInserted",
        ]) {
          if (r[k] !== undefined) out[k] = r[k];
        }
        if (r.dryRun) out.dryRun = true;
        this.resultCounts = out;
        this.resultDialog = true;
      } catch (e) {
        this.resultError = e.message;
        this.resultDialog = true;
      } finally {
        this.importing = false;
        this.importStatus = "";
      }
    },
  },
};
</script>
