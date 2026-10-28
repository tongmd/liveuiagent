import fs from 'node:fs/promises';
import path from 'node:path';

export const HOST_UI_REFERENCE = `# liveUI maintained UI API
This is the complete host contract. Read this file; do not search the filesystem, sessions, package managers or the web for SDK source. There is no npm package or import to install. The host injects window.liveuiagent and its ui API into the sandbox iframe. Write the application files in this work directory only.

## Entry point
For generated UI include <meta name="liveui-ui-protocol" content="liveui-tree-v1"> in head. Plain inline JavaScript uses const sdk=window.liveuiagent; const ui=sdk.ui. Do not redeclare, replace or reimplement SDK/ui methods. Never call fetch or an external model API.

## Persisted source content
sdk.storage.getItem(key) reads a stored string/null. await sdk.save(key,string) waits for the actual host storage acknowledgement. Build a candidate first, await save, then update memory/DOM. A failed save keeps old state and displays the error. Source records are arrays of objects with stable string id, original title/text/body/etc and optional checked. Photos have stable id and local validated raster data/blob src. Existing content and keys stay unchanged unless the actual request edits it.

## Generated structure
ui.read(treeKey) returns null or {tree,requestId,updatedAt,recordsFingerprint}.
ui.render(container,tree,{records,photos,onToggle,richState,onRichStateChange}) validates and renders a saved/default tree. Use the same renderer for fresh and reopened trees.
await ui.generate(container,userRequest,{storageKey:treeKey,getRecords:()=>records,getPhotos:()=>photos,tree:previousTree,onToggle,richState,onRichStateChange}) makes one maintained structured model call, validates all source references, awaits saving the tree, then replaces container. It returns the saved state. Do not call sdk.ai separately for tree generation, do not save the returned tree a second time, and do not replace it with a preset/custom canvas. Keep the old content and user draft on error.
Every supplied record/photo id must appear at least once in the generated tree. Model references never replace original record content. Scene parameters and numeric examples live in the tree; source records need real stable ids if provided.
Use one visible textarea/input with data-liveui-ui-request and one enabled button with data-liveui-action="ui.generate" for the actual request. The click handler reads that input and awaits ui.generate. Do not call AI on load. Disable only content-mutating controls during the call; unrelated navigation remains usable. Put the main generated tree on the first screen, not below a long form or duplicate old view.

## Scene3D: real offline WebGL
{type:"Scene3D",scene:{title:"空间结构示意",background:"#eef3fa",grid:true,objects:[{id:"idea",shape:"sphere",position:[-1,0,0],scale:[1,1,1],color:"#8b5cf6",label:"假设"},{id:"test",shape:"torus",position:[1,0,0],scale:[1,1,1],color:"#10b981",label:"检验",rotation:[0,25,0]}]}}
scene objects: 1..48, unique nonempty id, shape box|sphere|cylinder|cone|torus; position is exactly three finite values -20..20; scale exactly three values .05..10; color is #RRGGBB. label and scene.title optional max160 chars; rotation optional three degrees -360..360. background optional #RRGGBB, grid optional boolean. Max four Scene3D views per tree. No URL, scripts, shaders, arbitrary meshes or other fields. Drag rotates, wheel zooms, keyboard arrows/+/- navigate, and the built-in interval slider changes spacing locally without AI. Ordinary interactions are local; a genuinely new requested structure uses ui.generate.

## Plot: supplied numbers or mathematical illustrations
{type:"Plot",plot:{title:"数学示意 y=x²",kind:"line",xLabel:"x",yLabel:"y",series:[{name:"y=x²",color:"#6366f1",points:[[0,0],[1,1],[2,4]]}]}}
kind line|scatter|bar; 1..6 series, 1..160 finite [x,y] points per series, coordinates -1e9..1e9; name/color required. Titles/axis labels optional max160 chars. Never invent measured scientific results. Mark requested mathematical/geometry examples as illustrations.

## Diagram: relationships
{type:"Diagram",diagram:{title:"问题与检验",nodes:[{id:"a",label:"问题",x:0.2,y:0.5,color:"#6366f1"},{id:"b",label:"实验",x:0.8,y:0.5,color:"#10b981"}],edges:[{from:"a",to:"b",label:"检验"}]}}
1..24 nodes, unique id, label/color required, x/y finite 0..1. 0..48 edges with valid from/to ids and optional label. No URLs or executable fields.

## Other nodes and layout
Stack/Grid/Card/List/Checklist have children. Text has text. Image has photoId and optional text (alt). List/Checklist may be leaves {type:"Checklist",recordId:"existing-id",children:[]}. Text must not replace a record with generated text. Optional style only direction row|column, gap/padding integers0..32, columns1..4, tone default|muted|accent, align start|center|end. Max200 nodes/depth10; max80 children per container. Root example {type:"Grid",style:{columns:2},children:[SCENE_NODE,PLOT_NODE]}. On narrow screens layout adapts automatically.

## Complete integration pattern
const sdk=window.liveuiagent,ui=sdk.ui;
const TREE_KEY='layout',VIEW_KEY='scene-view';
let tree=ui.read(TREE_KEY)?.tree;
let richState=JSON.parse(sdk.storage.getItem(VIEW_KEY)||'{}');
let records=[]; // Load the actual existing records from their stable storage key.
const options=()=>({records,photos:[],richState,onRichStateChange:async(key,view)=>{const next={...richState,[key]:view};await sdk.save(VIEW_KEY,JSON.stringify(next));richState=next;}});
if(tree)ui.render(stage,tree,options());
generateButton.onclick=async()=>{generateButton.disabled=true;try{const state=await ui.generate(stage,requestInput.value,{...options(),storageKey:TREE_KEY,getRecords:()=>records,getPhotos:()=>[],tree});tree=state.tree;}catch(error){errorOutput.textContent=error.message;}finally{generateButton.disabled=false;}};
// Set requestInput data-liveui-ui-request and generateButton data-liveui-action="ui.generate".
// onToggle, if used, must save actual record changes before assigning records.

This contract is implementation guidance, not visible copy or a request for the user to write schemas. The user only describes what they want. Do not spend the generation deadline searching for SDK code.
`;

export async function writeHostUiReference(work){
  const file=path.join(work,'LIVEUI_UI_API.md');
  await fs.writeFile(file,HOST_UI_REFERENCE,{mode:0o444});
  await fs.chmod(file,0o444);
  return file;
}
