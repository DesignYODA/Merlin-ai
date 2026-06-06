import { useState, useEffect, useRef } from "react";
import * as d3 from "d3";
import { Search, Loader2 } from "lucide-react";
import { useData } from "./data-context";
import { industryKeywords, productList } from "../constants/constant";

// ─── Types ────────────────────────────────────────────────────────────────────

type TopicEntry = { topic: string; count: number; callIds: string[] };
type Category = "industry" | "product" | "other";

const CATEGORY_META: Record<
  Category,
  { label: string; palette: string[]; badge: string; accent: string }
> = {
  industry: {
    label: "Industry",
    palette: ["#10b981","#34d399","#6ee7b7","#059669","#047857","#065f46","#a7f3d0","#6fcf97","#27ae60","#1abc9c"],
    badge: "bg-emerald-500/10 text-emerald-400",
    accent: "#10b981",
  },
  product: {
    label: "Product",
    palette: ["#ec5d25","#f97316","#fb923c","#c2410c","#ea580c","#fdba74","#e8490a","#ff6b35","#d4500e","#f87171"],
    badge: "bg-[#ec5d25]/10 text-[#f5a07a]",
    accent: "#ec5d25",
  },
  other: {
    label: "Other",
    palette: ["#6366f1","#818cf8","#a5b4fc","#4f46e5","#7c3aed","#8b5cf6","#c4b5fd","#60a5fa","#38bdf8","#a78bfa"],
    badge: "bg-indigo-500/10 text-indigo-400",
    accent: "#6366f1",
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function categorize(topic: string): Category {
  const lower = topic.toLowerCase();
  if (industryKeywords.some((k) => lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)))
    return "industry";
  if (productList.some((k) => lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower)))
    return "product";
  return "other";
}

interface SunburstDatum {
  name: string;
  category?: Category;
  value?: number;
  callIds?: string[];
  children?: SunburstDatum[];
}

// ─── Zoomable Sunburst ────────────────────────────────────────────────────────

interface ZoomableSunburstProps {
  industryTopics: TopicEntry[];
  productTopics: TopicEntry[];
  otherTopics: TopicEntry[];
  selectedTopic: string | null;
  onSelect: (topic: string) => void;
}

function ZoomableSunburst({
  industryTopics,
  productTopics,
  otherTopics,
  selectedTopic,
  onSelect,
}: ZoomableSunburstProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => { onSelectRef.current = onSelect; }, [onSelect]);

  const [zoomLabel, setZoomLabel] = useState<string>("All Topics");
  const [zoomMentions, setZoomMentions] = useState<number>(0);

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;

    d3.select(el).selectAll("*").remove();
    setZoomLabel("All Topics");

    const allEmpty =
      industryTopics.length === 0 &&
      productTopics.length === 0 &&
      otherTopics.length === 0;
    if (allEmpty) return;

    // Internal coordinate space — SVG scales via viewBox
    const W = 600;
    const radius = W / 6; // 100

    // Build hierarchy data
    const data: SunburstDatum = {
      name: "All Topics",
      children: (
        [
          industryTopics.length > 0
            ? {
                name: "Industry", category: "industry" as Category,
                children: industryTopics.map((t) => ({
                  name: t.topic, value: t.count, callIds: t.callIds, category: "industry" as Category,
                })),
              }
            : null,
          productTopics.length > 0
            ? {
                name: "Product", category: "product" as Category,
                children: productTopics.map((t) => ({
                  name: t.topic, value: t.count, callIds: t.callIds, category: "product" as Category,
                })),
              }
            : null,
          otherTopics.length > 0
            ? {
                name: "Other", category: "other" as Category,
                children: otherTopics.map((t) => ({
                  name: t.topic, value: t.count, callIds: t.callIds, category: "other" as Category,
                })),
              }
            : null,
        ] as (SunburstDatum | null)[]
      ).filter((x): x is SunburstDatum => x !== null),
    };

    // Color: category accent for depth-1, palette by sibling index for leaves
    function getColor(d: any): string {
      if (d.depth === 0) return "#12121c";
      let anc = d;
      while (anc.depth > 1) anc = anc.parent;
      const cat = anc.data.category as Category | undefined;
      if (!cat) return "#8888a0";
      const meta = CATEGORY_META[cat];
      if (d.depth === 1) return meta.accent;
      const idx = (d.parent.children as any[]).indexOf(d);
      return meta.palette[idx % meta.palette.length];
    }

    const root = d3
      .hierarchy<SunburstDatum>(data)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    d3.partition<SunburstDatum>().size([2 * Math.PI, root.height + 1])(root);

    // Attach `.current` snapshot to each node
    root.each((d: any) => {
      d.current = { x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 };
    });

    const totalMentions = root.value ?? 0;
    setZoomMentions(totalMentions);

    const svg = d3
      .select(el)
      .attr("viewBox", `${-W / 2} ${-W / 2} ${W} ${W}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    // Arc generator — reads from `.current` which is interpolated during zoom
    const arcGen = d3
      .arc<any>()
      .startAngle((d: any) => d.x0)
      .endAngle((d: any) => d.x1)
      .padAngle((d: any) => Math.min((d.x1 - d.x0) / 2, 0.005))
      .padRadius(radius * 1.5)
      .innerRadius((d: any) => d.y0 * radius)
      .outerRadius((d: any) => Math.max(d.y0 * radius, d.y1 * radius - 1));

    function arcVisible(d: any) {
      return d.y1 <= 3 && d.y0 >= 1 && d.x1 > d.x0;
    }

    function labelVisible(d: any) {
      return d.y1 <= 3 && d.y0 >= 1 && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.03;
    }

    function labelTransform(d: any) {
      const x = ((d.x0 + d.x1) / 2) * (180 / Math.PI);
      const y = ((d.y0 + d.y1) / 2) * radius;
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
    }

    const descendants = root.descendants().slice(1); // exclude invisible root

    // ── Arcs ──
    const path = svg
      .append("g")
      .selectAll<SVGPathElement, any>("path")
      .data(descendants)
      .join("path")
      .attr("fill", (d: any) => getColor(d))
      .attr("fill-opacity", (d: any) => {
        if (!arcVisible((d as any).current)) return 0;
        if (selectedTopic && d.data.name === selectedTopic) return 1;
        return (d as any).children ? 0.82 : 0.65;
      })
      .attr("stroke", (d: any) =>
        selectedTopic && d.data.name === selectedTopic ? "#ffffff" : "none"
      )
      .attr("stroke-width", (d: any) =>
        selectedTopic && d.data.name === selectedTopic ? 2 : 0
      )
      .attr("pointer-events", (d: any) =>
        arcVisible((d as any).current) ? "auto" : "none"
      )
      .attr("d", (d: any) => arcGen((d as any).current))
      .style("cursor", "pointer");

    // Native SVG tooltip
    path
      .append("title")
      .text((d: any) => {
        const parts: string[] = d
          .ancestors()
          .reverse()
          .slice(1)
          .map((a: any) => a.data.name as string);
        return `${parts.join(" › ")}\n${d.value} mention${d.value !== 1 ? "s" : ""}`;
      });

    // ── Labels ──
    const label = svg
      .append("g")
      .attr("pointer-events", "none")
      .attr("text-anchor", "middle")
      .style("user-select", "none")
      .selectAll<SVGTextElement, any>("text")
      .data(descendants)
      .join("text")
      .attr("dy", "0.35em")
      .attr("fill", "#ffffff")
      .attr("fill-opacity", (d: any) => +labelVisible((d as any).current))
      .attr("transform", (d: any) => labelTransform((d as any).current))
      .style("font-size", "10px")
      .style("font-weight", (d: any) => ((d as any).depth === 1 ? "700" : "500"))
      .text((d: any) => {
        const n = d.data.name as string;
        return n.length > 14 ? n.slice(0, 13) + "…" : n;
      });

    // ── Center circle (zoom-out button) ──
    const centerCircle = svg
      .append("circle")
      .datum(root as any)
      .attr("r", radius)
      .attr("fill", "#0d0d15")
      .attr("stroke", "#2a2a3e")
      .attr("stroke-width", 1)
      .style("cursor", "pointer");

    const centerMain = svg
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "-0.15em")
      .attr("fill", "#e0e0ee")
      .style("font-size", "13px")
      .style("font-weight", "700")
      .style("pointer-events", "none")
      .text("All Topics");

    const centerSub = svg
      .append("text")
      .attr("text-anchor", "middle")
      .attr("dy", "1.3em")
      .attr("fill", "#555568")
      .style("font-size", "10px")
      .style("pointer-events", "none")
      .text(`${totalMentions} mentions`);

    // ── Zoom transition ──
    function clicked(_evt: Event, p: any) {
      // Update center circle datum to p's parent for zoom-out on next click
      centerCircle.datum(p.parent || root);

      const newLabel: string = p.parent ? (p.data.name as string) : "All Topics";
      const newMentions: number = p.value ?? 0;
      setZoomLabel(newLabel);
      setZoomMentions(newMentions);
      centerMain.text(newLabel);
      centerSub.text(`${newMentions} mentions`);

      // Compute target positions relative to clicked node
      root.each((d: any) => {
        d.target = {
          x0:
            Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) *
            2 *
            Math.PI,
          x1:
            Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) *
            2 *
            Math.PI,
          y0: Math.max(0, d.y0 - p.depth),
          y1: Math.max(0, d.y1 - p.depth),
        };
      });

      const t = svg.transition().duration(750);

      // Transition arcs
      path
        .transition(t as any)
        .tween("data", (d: any) => {
          const i = d3.interpolate(d.current, d.target);
          return (tt: number) => {
            d.current = i(tt);
          };
        })
        .filter(function (this: SVGPathElement, d: any) {
          return (
            +(this.getAttribute("fill-opacity") ?? 0) > 0 ||
            arcVisible(d.target)
          );
        })
        .attr("fill-opacity", (d: any) => {
          if (!arcVisible(d.target)) return 0;
          if (selectedTopic && d.data.name === selectedTopic) return 1;
          return (d as any).children ? 0.82 : 0.65;
        })
        .attr("pointer-events", (d: any) =>
          arcVisible(d.target) ? "auto" : "none"
        )
        .attrTween("d", (d: any) => () => arcGen(d.current) ?? "");

      // Transition labels
      label
        .filter(function (this: SVGTextElement, d: any) {
          return (
            +(this.getAttribute("fill-opacity") ?? 0) > 0 ||
            labelVisible(d.target)
          );
        })
        .transition(t as any)
        .attr("fill-opacity", (d: any) => +labelVisible(d.target))
        .attrTween("transform", (d: any) => () => labelTransform(d.current));
    }

    // ── Click handlers ──
    path.on("click", (evt: Event, d: any) => {
      if ((d as any).children) {
        // Category ring → zoom in
        clicked(evt, d);
      } else {
        // Leaf → select/deselect topic
        onSelectRef.current(d.data.name as string);
      }
    });

    centerCircle.on("click", (evt: Event, p: any) => {
      clicked(evt, p);
    });

    // Hover glow for leaves
    path
      .filter((d: any) => !(d as any).children)
      .on("mouseenter", function (this: SVGPathElement) {
        d3.select(this).attr("fill-opacity", 1);
      })
      .on("mouseleave", function (this: SVGPathElement, _: Event, d: any) {
        const isSelected = selectedTopic && d.data.name === selectedTopic;
        d3.select(this).attr("fill-opacity", isSelected ? 1 : 0.65);
      });

    // Hover glow for category rings
    path
      .filter((d: any) => !!(d as any).children)
      .on("mouseenter", function (this: SVGPathElement) {
        d3.select(this).attr("fill-opacity", 1);
      })
      .on("mouseleave", function (this: SVGPathElement, _: Event, d: any) {
        d3.select(this).attr("fill-opacity", arcVisible((d as any).current) ? 0.82 : 0);
      });
  }, [industryTopics, productTopics, otherTopics, selectedTopic]);

  return (
    <div className="bg-[#12121c] border border-[#1e1e2e] rounded-xl p-6">
      {/* Header row */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <span className="text-white" style={{ fontSize: "0.9rem", fontWeight: 600 }}>
            Keyword Distribution
          </span>
          <span className="text-[#555568]" style={{ fontSize: "0.68rem" }}>
            · click ring to zoom in · click keyword to filter calls below
          </span>
        </div>
        {/* Category legend */}
        <div className="flex items-center gap-5">
          {(["industry", "product", "other"] as Category[]).map((cat) => (
            <div key={cat} className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: CATEGORY_META[cat].accent }}
              />
              <span className="text-[#8888a0]" style={{ fontSize: "0.68rem" }}>
                {CATEGORY_META[cat].label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Breadcrumb — shows current zoom level */}
      <div className="flex items-center gap-1.5 mb-4 min-h-[1.25rem]">
        {zoomLabel !== "All Topics" ? (
          <>
            <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>All Topics</span>
            <span className="text-[#555568]" style={{ fontSize: "0.72rem" }}>›</span>
            <span
              className="px-2 py-0.5 rounded-md text-white"
              style={{
                fontSize: "0.72rem",
                fontWeight: 600,
                backgroundColor:
                  CATEGORY_META[zoomLabel.toLowerCase() as Category]?.accent + "22" ??
                  "#8888a022",
                color:
                  CATEGORY_META[zoomLabel.toLowerCase() as Category]?.accent ??
                  "#c0c0d0",
              }}
            >
              {zoomLabel}
            </span>
            <span className="text-[#555568] ml-1" style={{ fontSize: "0.68rem" }}>
              {zoomMentions} mentions · click center to zoom out
            </span>
          </>
        ) : (
          <span className="text-[#555568]" style={{ fontSize: "0.68rem" }}>
            {zoomMentions} total mentions across all categories
          </span>
        )}
      </div>

      {/* SVG container — maintains 1:1 aspect ratio via viewBox */}
      <div className="flex justify-center">
        <svg
          ref={svgRef}
          style={{ width: "100%", maxWidth: 600, display: "block" }}
        />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function TopicsPage() {
  const { calls, analytics, isLoading, isLive } = useData();
  const { topTopics } = analytics;
  const [search, setSearch] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);

  const toggle = (t: string) =>
    setSelectedTopic((prev) => (prev === t ? null : t));

  const searchLower = search.toLowerCase();

  const categorized = topTopics.map((t) => ({
    ...t,
    category: categorize(t.topic),
  }));

  const forCategory = (cat: Category) =>
    categorized.filter(
      (t) =>
        t.category === cat && t.topic.toLowerCase().includes(searchLower)
    );

  const industryTopics = forCategory("industry");
  const productTopics = forCategory("product");
  const otherTopics = forCategory("other");

  const selectedTopicCalls = selectedTopic
    ? calls.filter((c) =>
        c.topics.some((t) => t.toLowerCase() === selectedTopic.toLowerCase())
      )
    : [];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[#ec5d25] animate-spin" />
          <p className="text-[#8888a0]" style={{ fontSize: "0.875rem" }}>
            Extracting topics...
          </p>
        </div>
      </div>
    );
  }

  const totalTopics = topTopics.length;

  return (
    <div className="p-8 space-y-8">
      {/* Page header */}
      <div>
        <h1 className="text-white" style={{ fontSize: "1.75rem", fontWeight: 700 }}>
          Topics & Keywords
        </h1>
        <p className="text-[#8888a0] mt-1" style={{ fontSize: "0.875rem" }}>
          {isLive
            ? `${totalTopics} unique keywords from ${analytics.summary?.totalCalls ?? 0} Fireflies calls`
            : "Track trending topics across meetings"}
        </p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 bg-[#12121c] border border-[#1e1e2e] rounded-xl px-4 py-2.5">
        <Search className="w-4 h-4 text-[#8888a0]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter keywords..."
          className="flex-1 bg-transparent border-none outline-none text-white placeholder-[#555568]"
          style={{ fontSize: "0.875rem" }}
        />
      </div>

      {/* Sunburst chart */}
      {totalTopics === 0 ? (
        <div
          className="py-12 text-center text-[#555568]"
          style={{ fontSize: "0.85rem" }}
        >
          No keywords found in your calls.
        </div>
      ) : industryTopics.length === 0 &&
        productTopics.length === 0 &&
        otherTopics.length === 0 ? (
        <div
          className="py-12 text-center text-[#555568]"
          style={{ fontSize: "0.85rem" }}
        >
          No keywords match your search.
        </div>
      ) : (
        <ZoomableSunburst
          industryTopics={industryTopics}
          productTopics={productTopics}
          otherTopics={otherTopics}
          selectedTopic={selectedTopic}
          onSelect={toggle}
        />
      )}

      {/* Selected topic call list */}
      {selectedTopic && selectedTopicCalls.length > 0 && (
        <div className="bg-[#12121c] border border-[#ec5d25]/20 rounded-xl p-6">
          <h3
            className="text-white mb-4"
            style={{ fontSize: "1rem", fontWeight: 600 }}
          >
            Calls mentioning "{selectedTopic}"
          </h3>
          <div className="space-y-3">
            {selectedTopicCalls.map((call) => (
              <div
                key={call.id}
                className="flex items-center justify-between p-3 rounded-lg bg-[#0f0f18] hover:bg-[#1a1a28] transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p
                    className="text-white truncate"
                    style={{ fontSize: "0.85rem" }}
                  >
                    {call.title}
                  </p>
                  <p
                    className="text-[#8888a0]"
                    style={{ fontSize: "0.75rem" }}
                  >
                    {call.aeName} · {call.date} · {call.duration}
                  </p>
                </div>
                <span
                  className={`px-2 py-1 rounded-md shrink-0 ml-3 ${
                    call.sentiment === "positive"
                      ? "bg-emerald-500/10 text-emerald-400"
                      : call.sentiment === "negative"
                      ? "bg-rose-500/10 text-rose-400"
                      : "bg-amber-500/10 text-amber-400"
                  }`}
                  style={{ fontSize: "0.7rem" }}
                >
                  {call.sentiment}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
