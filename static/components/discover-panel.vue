<template>
  <div class="mx-auto max-w-5xl p-6">
    <h2 class="text-xl font-semibold tracking-tight">Settings</h2>
    <p class="mt-1 mb-5 text-sm text-muted-foreground">
      The plugin imports the readable values and writable commands under
      the views you pick below. Use <span class="font-medium">Advanced
      filters</span> to narrow by discipline or object type when you really
      need to. Saved to <code class="font-mono text-xs">state/config.json</code>.
    </p>

    <div v-if="error" class="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <div class="flex items-start gap-2">
        <AlertCircle class="h-4 w-4 mt-0.5 shrink-0" />
        <div class="flex-1">{{ error }}</div>
        <button class="opacity-60 hover:opacity-100" @click="error = ''"><X class="h-4 w-4" /></button>
      </div>
    </div>

    <!-- System Views -->
    <div class="rounded-lg border bg-card shadow-sm mb-4">
      <div class="flex items-center px-4 py-3 border-b">
        <h3 class="text-sm font-semibold">System Views</h3>
        <span v-if="views.length" class="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{{ views.length }}</span>
        <span v-if="selectedViews.length" class="ml-1 rounded-md border px-1.5 py-0.5 text-xs">{{ selectedViews.length }} selected</span>
        <div class="flex-1"></div>
        <button class="rounded-md p-1.5 hover:bg-accent disabled:opacity-50" :disabled="loadingViews" @click="reloadViews">
          <RefreshCw class="h-4 w-4" :class="loadingViews ? 'animate-spin' : ''" />
        </button>
      </div>
      <div class="p-2">
        <div v-if="!views.length && !loadingViews" class="px-2 py-4 text-sm text-muted-foreground">No views loaded yet.</div>
        <ul class="divide-y">
          <li v-for="v in views" :key="v.SystemId + ':' + v.ViewId"
              class="flex items-start gap-3 px-2 py-2 hover:bg-accent rounded cursor-pointer"
              @click="toggleView(v, !isViewSelected(v))">
            <button type="button" :class="cbClass(isViewSelected(v))">
              <Check v-if="isViewSelected(v)" class="h-3 w-3" />
            </button>
            <div class="flex-1 min-w-0">
              <div class="text-sm font-medium">{{ v.Descriptor || v.Name }}</div>
              <div class="text-xs text-muted-foreground truncate">
                {{ v.SystemName }} / view {{ v.ViewId }}
                <span class="ml-1">· {{ v.Designation }}</span>
              </div>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- Advanced filters (custom accordion) -->
    <div class="rounded-lg border bg-card shadow-sm mb-6 overflow-hidden">
      <button class="flex w-full items-center px-4 py-3 text-sm font-semibold hover:bg-accent/30" @click="advancedOpen = !advancedOpen">
        <Filter class="h-4 w-4 mr-2 text-muted-foreground" />
        <span>Advanced filters</span>
        <span v-if="advancedSummary" class="ml-3 rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{{ advancedSummary }}</span>
        <div class="flex-1"></div>
        <ChevronDown class="h-4 w-4 text-muted-foreground transition-transform" :class="advancedOpen ? 'rotate-180' : ''" />
      </button>
      <div v-show="advancedOpen" class="border-t">
        <p class="px-4 pt-3 text-xs text-muted-foreground">Empty = no filter. When set, only nodes matching <em>all</em> non-empty filters are imported.</p>
        <div class="grid gap-4 p-4 md:grid-cols-2">
          <div class="rounded-lg border bg-card">
            <div class="flex items-center px-3 py-2 border-b">
              <h4 class="text-sm font-semibold">Disciplines</h4>
              <span v-if="disciplines.length" class="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{{ disciplines.length }}</span>
              <span v-if="selectedDisciplines.length" class="ml-1 rounded-md border px-1.5 py-0.5 text-xs">{{ selectedDisciplines.length }}</span>
              <div class="flex-1"></div>
              <button class="rounded-md p-1 hover:bg-accent disabled:opacity-50" :disabled="loadingDisciplines" @click="reloadDisciplines">
                <RefreshCw class="h-3.5 w-3.5" :class="loadingDisciplines ? 'animate-spin' : ''" />
              </button>
            </div>
            <div class="p-2">
              <div class="relative mb-2">
                <Search class="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <input v-model="disciplineFilter" placeholder="filter…"
                  class="w-full rounded-md border bg-background pl-7 pr-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <ul class="max-h-80 overflow-y-auto divide-y">
                <li v-for="d in filteredDisciplines" :key="disciplineId(d)"
                    class="flex items-start gap-3 px-2 py-1.5 hover:bg-accent rounded cursor-pointer"
                    @click="toggleDiscipline(disciplineId(d), !isDisciplineSelected(disciplineId(d)))">
                  <button type="button" :class="cbClass(isDisciplineSelected(disciplineId(d)))">
                    <Check v-if="isDisciplineSelected(disciplineId(d))" class="h-3 w-3" />
                  </button>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm">{{ disciplineLabel(d) }}</div>
                    <div class="text-xs text-muted-foreground">
                      id {{ disciplineId(d) }}
                      <span v-if="disciplineSubCount(d)"> · {{ disciplineSubCount(d) }} subdisciplines</span>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </div>

          <div class="rounded-lg border bg-card">
            <div class="flex items-center px-3 py-2 border-b">
              <h4 class="text-sm font-semibold">Object Types</h4>
              <span v-if="objectTypes.length" class="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-xs">{{ objectTypes.length }}</span>
              <span v-if="selectedObjectTypes.length" class="ml-1 rounded-md border px-1.5 py-0.5 text-xs">{{ selectedObjectTypes.length }}</span>
              <div class="flex-1"></div>
              <button class="rounded-md p-1 hover:bg-accent disabled:opacity-50" :disabled="loadingObjectTypes" @click="reloadObjectTypes">
                <RefreshCw class="h-3.5 w-3.5" :class="loadingObjectTypes ? 'animate-spin' : ''" />
              </button>
            </div>
            <div class="p-2">
              <div class="relative mb-2">
                <Search class="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                <input v-model="objectTypeFilter" placeholder="filter…"
                  class="w-full rounded-md border bg-background pl-7 pr-2 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              <ul class="max-h-80 overflow-y-auto divide-y">
                <li v-for="o in filteredObjectTypes" :key="objectTypeId(o)"
                    class="flex items-start gap-3 px-2 py-1.5 hover:bg-accent rounded cursor-pointer"
                    @click="toggleObjectType(objectTypeId(o), !isObjectTypeSelected(objectTypeId(o)))">
                  <button type="button" :class="cbClass(isObjectTypeSelected(objectTypeId(o)))">
                    <Check v-if="isObjectTypeSelected(objectTypeId(o))" class="h-3 w-3" />
                  </button>
                  <div class="flex-1 min-w-0">
                    <div class="text-sm">{{ objectTypeLabel(o) }}</div>
                    <div class="text-xs text-muted-foreground">
                      id {{ objectTypeId(o) }}
                      <span v-if="objectTypeSubCount(o)"> · {{ objectTypeSubCount(o) }} subtypes</span>
                    </div>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="flex items-center">
      <span v-if="lastSavedAt" class="text-xs text-muted-foreground">Saved {{ lastSavedAt }}</span>
      <div class="flex-1"></div>
      <button :disabled="saving"
        class="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        @click="save">
        <Save class="h-4 w-4" :class="saving ? 'animate-pulse' : ''" />
        Save selection
      </button>
    </div>
  </div>
</template>

<script>
import { AlertCircle, Check, ChevronDown, Filter, RefreshCw, Save, Search, X } from "lucide-vue-next";

const discover = window.NF.discover;

export default {
  components: { AlertCircle, Check, ChevronDown, Filter, RefreshCw, Save, Search, X },
  data: () => ({
    views: [], disciplines: [], objectTypes: [],
    selectedViews: [], selectedDisciplines: [], selectedObjectTypes: [],
    disciplineFilter: "", objectTypeFilter: "",
    loadingViews: false, loadingDisciplines: false, loadingObjectTypes: false,
    saving: false, lastSavedAt: "", error: "", advancedOpen: false,
  }),
  computed: {
    filteredDisciplines() {
      const q = (this.disciplineFilter || "").trim().toLowerCase();
      if (!q) return this.disciplines;
      return this.disciplines.filter((d) => this.disciplineLabel(d).toLowerCase().includes(q));
    },
    filteredObjectTypes() {
      const q = (this.objectTypeFilter || "").trim().toLowerCase();
      if (!q) return this.objectTypes;
      return this.objectTypes.filter((o) => this.objectTypeLabel(o).toLowerCase().includes(q));
    },
    advancedSummary() {
      const parts = [];
      if (this.selectedDisciplines.length) parts.push(`${this.selectedDisciplines.length} discipline${this.selectedDisciplines.length === 1 ? "" : "s"}`);
      if (this.selectedObjectTypes.length) parts.push(`${this.selectedObjectTypes.length} object type${this.selectedObjectTypes.length === 1 ? "" : "s"}`);
      return parts.join(" · ");
    },
  },
  async mounted() {
    try {
      const cfg = await discover.loadConfig();
      const c = cfg.config || {};
      this.selectedViews = c.selectedViews || [];
      this.selectedDisciplines = c.selectedDisciplines || [];
      this.selectedObjectTypes = c.selectedObjectTypes || [];
      if (this.selectedDisciplines.length || this.selectedObjectTypes.length) this.advancedOpen = true;
    } catch (e) { this.error = "load_config: " + e.message; }
    await this.reloadViews();
    if (this.advancedOpen) await Promise.all([this.reloadDisciplines(), this.reloadObjectTypes()]);
  },
  watch: {
    advancedOpen(v) {
      if (v) {
        if (!this.disciplines.length && !this.loadingDisciplines) this.reloadDisciplines();
        if (!this.objectTypes.length && !this.loadingObjectTypes) this.reloadObjectTypes();
      }
    },
  },
  methods: {
    cbClass(checked) {
      return [
        "mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border",
        checked ? "bg-primary border-primary text-primary-foreground" : "bg-background border-input",
      ];
    },
    disciplineId(d) { return d.DisciplineId ?? d.Id ?? d.id ?? d.disciplineId; },
    disciplineLabel(d) { return d.DisciplineDescriptor || d.Descriptor || d.name || d.Name || "discipline " + this.disciplineId(d); },
    disciplineSubCount(d) { const s = d.SubDisciplines || d.subDisciplines || []; return Array.isArray(s) ? s.length : 0; },
    objectTypeId(o) { return o.ObjectTypeId ?? o.TypeId ?? o.Id ?? o.id; },
    objectTypeLabel(o) { return o.ObjectTypeDescriptor || o.TypeDescriptor || o.Descriptor || o.name || "type " + this.objectTypeId(o); },
    objectTypeSubCount(o) { const s = o.SubObjectTypes || o.SubTypes || []; return Array.isArray(s) ? s.length : 0; },
    isViewSelected(v) { return this.selectedViews.some((s) => s.systemId === v.SystemId && s.viewId === v.ViewId); },
    toggleView(v, on) {
      if (on) { if (!this.isViewSelected(v)) this.selectedViews = [...this.selectedViews, { systemId: v.SystemId, viewId: v.ViewId }]; }
      else this.selectedViews = this.selectedViews.filter((s) => !(s.systemId === v.SystemId && s.viewId === v.ViewId));
    },
    isDisciplineSelected(id) { return this.selectedDisciplines.includes(id); },
    toggleDiscipline(id, on) {
      if (on) { if (!this.selectedDisciplines.includes(id)) this.selectedDisciplines = [...this.selectedDisciplines, id]; }
      else this.selectedDisciplines = this.selectedDisciplines.filter((x) => x !== id);
    },
    isObjectTypeSelected(id) { return this.selectedObjectTypes.includes(id); },
    toggleObjectType(id, on) {
      if (on) { if (!this.selectedObjectTypes.includes(id)) this.selectedObjectTypes = [...this.selectedObjectTypes, id]; }
      else this.selectedObjectTypes = this.selectedObjectTypes.filter((x) => x !== id);
    },
    async reloadViews() {
      this.loadingViews = true; this.error = "";
      try { const r = await discover.listViews(); this.views = (r && r.views) || []; }
      catch (e) { this.error = "list_views: " + e.message; }
      finally { this.loadingViews = false; }
    },
    async reloadDisciplines() {
      this.loadingDisciplines = true; this.error = "";
      try { const r = await discover.listDisciplines(); this.disciplines = (r && r.disciplines) || []; }
      catch (e) { this.error = "list_disciplines: " + e.message; }
      finally { this.loadingDisciplines = false; }
    },
    async reloadObjectTypes() {
      this.loadingObjectTypes = true; this.error = "";
      try { const r = await discover.listObjectTypes(); this.objectTypes = (r && r.objectTypes) || []; }
      catch (e) { this.error = "list_object_types: " + e.message; }
      finally { this.loadingObjectTypes = false; }
    },
    async save() {
      this.saving = true; this.error = "";
      try {
        await discover.saveConfig({
          selectedViews: this.selectedViews,
          selectedDisciplines: this.selectedDisciplines,
          selectedObjectTypes: this.selectedObjectTypes,
        });
        this.lastSavedAt = new Date().toLocaleTimeString();
      } catch (e) { this.error = "save_config: " + e.message; }
      finally { this.saving = false; }
    },
  },
};
</script>
