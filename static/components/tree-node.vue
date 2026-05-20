<template>
  <div>
    <div class="flex items-center px-1 py-0.5 rounded hover:bg-accent/50" :style="{ paddingLeft: depth * 16 + 'px' }">
      <button v-if="node.HasChild"
        class="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-accent disabled:opacity-50"
        :disabled="loading || loadingProperties"
        @click="toggle">
        <Loader2 v-if="loading || loadingProperties" class="h-3.5 w-3.5 animate-spin" />
        <ChevronDown v-else-if="expanded" class="h-3.5 w-3.5" />
        <ChevronRight v-else class="h-3.5 w-3.5" />
      </button>
      <div v-else class="h-6 w-6 shrink-0"></div>

      <button v-if="isProgram"
        type="button"
        :disabled="downloading"
        class="ml-1 mr-2 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        :title="`Download PPCL source for ${node.Descriptor || node.Name}`"
        @click.stop="downloadProgram">
        <Loader2 v-if="downloading" class="h-3.5 w-3.5 animate-spin" />
        <Download v-else class="h-3.5 w-3.5" />
      </button>
      <button v-else
        type="button"
        :disabled="checkboxState.disabled"
        :class="cbClass"
        @click="onToggleSelect">
        <Check v-if="checkboxState.checked && !checkboxState.indeterminate" class="h-3 w-3" />
        <Minus v-if="checkboxState.indeterminate" class="h-3 w-3" />
      </button>

      <div class="min-w-0 flex-1 text-sm leading-6" :class="checkboxState.disabled ? 'opacity-60' : ''">
        <span class="font-medium">{{ node.Descriptor || node.Name }}</span>
        <span v-if="shortType" class="ml-2 text-xs text-muted-foreground">{{ shortType }}</span>
        <span v-if="propCountHint" class="ml-2 text-xs text-muted-foreground">· {{ propCountHint }}</span>
      </div>
      <button v-if="hasGraphic"
        type="button"
        class="ml-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        :title="`Download graphic for ${node.Descriptor || node.Name}`"
        @click.stop="onDownloadGraphic">
        <ImageIcon class="h-3.5 w-3.5" />
      </button>
      <span v-if="disciplineLabel" class="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {{ disciplineLabel }}
      </span>
    </div>

    <div v-if="error" class="text-xs text-destructive" :style="{ paddingLeft: (depth + 1) * 16 + 56 + 'px' }">{{ error }}</div>
    <div v-if="propertiesError" class="text-xs text-destructive" :style="{ paddingLeft: (depth + 1) * 16 + 56 + 'px' }">properties: {{ propertiesError }}</div>

    <div v-if="expanded">
      <div v-for="p in ownProperties" :key="'prop-' + p.PropertyName"
           class="flex items-center px-1 py-0.5" :style="{ paddingLeft: (depth + 1) * 16 + 'px' }">
        <div class="h-5 w-6 shrink-0"></div>
        <Dot class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span class="ml-1 font-mono text-xs text-muted-foreground">{{ p.PropertyName }}</span>
        <span class="ml-2 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ p.Type }}</span>
      </div>

      <div v-if="!children.length && !ownProperties.length && !loading && !loadingProperties && !error"
           class="text-xs text-muted-foreground" :style="{ paddingLeft: (depth + 1) * 16 + 56 + 'px' }">(empty)</div>

      <tree-node v-for="c in visibleChildren" :key="c.Designation"
        :node="c" :system-id="systemId" :view-id="viewId" :depth="depth + 1"
        :selection="selection"
        @select="$emit('select', $event)"
        @download-graphic="$emit('download-graphic', $event)" />
      <button
        v-if="children.length > visibleCount"
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground px-2 py-1"
        :style="{ marginLeft: (depth + 1) * 16 + 56 + 'px' }"
        @click="visibleCount += 200"
      >
        Show 200 more ({{ children.length - visibleCount }} remaining)
      </button>
    </div>
  </div>
</template>

<script>
// `Image` aliased to ImageIcon because the bare name collides with the
// browser's HTMLImageElement constructor and Vue's template resolver
// occasionally picks up the wrong one inside an SFC compiled at runtime.
import { Check, ChevronDown, ChevronRight, Dot, Download, Image as ImageIcon, Loader2, Minus } from "lucide-vue-next";

const discover = window.NF.discover;

function isDescendant(ancestor, candidate) {
  if (candidate === ancestor) return false;
  if (!candidate.startsWith(ancestor)) return false;
  const next = candidate.charAt(ancestor.length);
  return next === "." || next === ":";
}

export default {
  name: "TreeNode",
  components: { Check, ChevronDown, ChevronRight, Dot, Download, ImageIcon, Loader2, Minus },
  props: {
    node: { type: Object, required: true },
    systemId: { type: Number, required: true },
    viewId: { type: Number, required: true },
    depth: { type: Number, default: 0 },
    selection: { type: Object, required: true },
  },
  emits: ["select", "download-graphic"],
  data: () => ({
    expanded: false, loading: false, loadingProperties: false,
    error: "", propertiesError: "",
    children: [], ownProperties: [], propertiesFetched: false,
    downloading: false,
    visibleCount: 200,
    hasGraphic: false,
    graphicChecked: false,
  }),
  computed: {
    visibleChildren() { return this.children.slice(0, this.visibleCount); },
    isProgram() {
      const a = this.node.Attributes || {};
      return a.TypeDescriptor === "Program" || a.ManagedTypeName === "Apogee PPCL";
    },
    shortType() {
      const a = this.node.Attributes || {};
      return a.TypeDescriptor || a.ManagedTypeName || a.ObjectModelName || "";
    },
    disciplineLabel() { return (this.node.Attributes || {}).DisciplineDescriptor || ""; },
    propCountHint() {
      if (this.ownProperties.length > 0) return `${this.ownProperties.length} prop${this.ownProperties.length === 1 ? "" : "s"}`;
      return "";
    },
    canFetchProperties() {
      const id = this.node.ObjectId;
      return id && id !== this.node.Designation;
    },
    checkboxState() {
      const d = this.node.Designation;
      if (!d) return { checked: false, disabled: true, indeterminate: false };
      let coveredBy = null;
      let hasDescendant = false;
      for (const s of this.selection.keys()) {
        if (isDescendant(s, d)) { coveredBy = s; break; }
        if (isDescendant(d, s)) hasDescendant = true;
      }
      if (coveredBy) return { checked: true, disabled: true, indeterminate: false };
      if (this.selection.has(d)) return { checked: true, disabled: false, indeterminate: false };
      if (hasDescendant) return { checked: false, disabled: false, indeterminate: true };
      return { checked: false, disabled: false, indeterminate: false };
    },
    cbClass() {
      const s = this.checkboxState;
      return [
        "ml-1 mr-2 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border",
        s.checked && !s.indeterminate ? "bg-primary border-primary text-primary-foreground" : "bg-background border-input",
        s.indeterminate ? "bg-primary/40 border-primary/40 text-primary-foreground" : "",
        s.disabled ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
      ];
    },
  },
  // Probe each row's graphic availability on mount. The cache on the
  // hook side makes repeat checks effectively free, so even folders
  // with many siblings only pay once.
  mounted() {
    if (!this.graphicChecked && this.canFetchProperties) this.checkGraphic();
  },
  methods: {
    async toggle() {
      if (this.expanded) { this.expanded = false; return; }
      this.expanded = true;
      const tasks = [];
      if (!this.children.length && !this.loading) tasks.push(this.loadChildren());
      if (!this.propertiesFetched && !this.loadingProperties && this.canFetchProperties) tasks.push(this.loadOwnProperties());
      await Promise.all(tasks);
    },
    async checkGraphic() {
      // Cheap probe (200 / 204). Skip view-roots — same canFetchProperties
      // guard rules out synthetic ObjectId == Designation cases.
      try {
        const r = await discover.hasGraphic(this.node.ObjectId);
        this.hasGraphic = !!(r && r.hasGraphic);
      } catch (e) {
        // Silent: not all nodes are graphical, network blips are fine to ignore.
      } finally {
        this.graphicChecked = true;
      }
    },
    onDownloadGraphic() {
      this.$emit("download-graphic", {
        designation: this.node.Designation,
        objectId: this.node.ObjectId,
        name: this.node.Descriptor || this.node.Name || this.node.ObjectId,
      });
    },
    async loadChildren() {
      this.loading = true; this.error = "";
      try {
        const r = await discover.listChildren(this.systemId, this.viewId, this.node.Designation);
        this.children = (r && r.nodes) || [];
      } catch (e) { this.error = e.message; }
      finally { this.loading = false; }
    },
    async loadOwnProperties() {
      this.loadingProperties = true; this.propertiesError = "";
      try {
        const mt = (this.node.Attributes && this.node.Attributes.ManagedTypeName) || "";
        const r = await discover.listNodeProperties(this.node.ObjectId, mt);
        this.ownProperties = (r && r.properties) || [];
        this.propertiesFetched = true;
      } catch (e) { this.propertiesError = e.message; }
      finally { this.loadingProperties = false; }
    },
    onToggleSelect() {
      if (this.checkboxState.disabled) return;
      this.$emit("select", {
        systemId: this.systemId,
        viewId: this.viewId,
        designation: this.node.Designation,
        node: this.node,
        on: !this.checkboxState.checked,
      });
    },
    async downloadProgram() {
      if (this.downloading) return;
      this.downloading = true;
      try {
        const r = await discover.downloadProgram(this.node.ObjectId);
        const src = (r && r.source) || "";
        const safe = (this.node.Name || this.node.Descriptor || "program").replace(/[^A-Za-z0-9._-]/g, "_");
        const blob = new Blob([src], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = safe + ".ppcl";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } catch (e) {
        this.error = "download: " + e.message;
      } finally {
        this.downloading = false;
      }
    },
  },
};
</script>
