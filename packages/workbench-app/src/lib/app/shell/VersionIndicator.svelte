<script lang="ts">
import { displayVersion } from "$lib/features/releases";

type Props = {
  currentVersion: string;
};

let { currentVersion }: Props = $props();

const currentLabel = $derived(displayVersion(currentVersion));
</script>

<span
  class="inline-flex items-center rounded-sm border border-border bg-transparent px-1.5 py-0.5 font-mono text-xs font-medium leading-none text-muted-foreground"
  aria-label={`ZeroLeak AI ${currentLabel}`}
  title={`ZeroLeak AI ${currentLabel}`}
>
  {currentLabel}
</span>
