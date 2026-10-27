type Row=Record<string,any>;
const boundCards=new WeakSet<object>();
const text=(v:unknown)=>typeof v==='string'?v.trim():'';
const url=(v:unknown)=>{try{const u=new URL(text(v));return /^https?:$/.test(u.protocol)&&!u.username&&!u.password&&u.href.length<=2048?u.href:'';}catch{return '';}};
export function isBoundPublicCard(value:unknown):value is Row{return !!value&&typeof value==='object'&&boundCards.has(value as object);}
export function prefetchReceipt(tool:{id:string;apiName:string},args:Row|undefined,response:unknown,error?:unknown):Row{
 return {phase:'prefetch',capability:tool.id,api:tool.apiName,ok:error===undefined,executionState:error===undefined?'succeeded':args?'dispatch_failed':'preflight_not_started',...(args?{request:args}:{}),...(error===undefined?{response}:{error:String((error as Error)?.message??error).slice(0,1000)}),requestSource:'public-tool-prefetch'};
}
export function publicPrefetchEvidence(results:Row):Row[]{return Object.values(results).filter((v:any)=>v&&v.phase==='prefetch'&&v.requestSource==='public-tool-prefetch') as Row[];}
/** Only host-held successful HTTP receipts grant a card a source. Model brands are ignored. */
export function bindPublicCard(item:Row,evidence:Row[]):(Row & {name:string;id:string;detail:string})|null{
 if(Object.hasOwn(item,'appRecordId')&&item.appRecordId!==undefined&&item.appRecordId!==null)return null;
 if(Object.hasOwn(item,'id')&&item.id!==undefined&&item.id!==null&&(typeof item.id!=='string'||!item.id.trim()))return null;
 const candidates:Row[]=[];
 for(const receipt of evidence){
  if(receipt.ok!==true||!['web-tool-dispatched-arguments','public-tool-prefetch'].includes(receipt.requestSource))continue;
  const r=receipt.response;if(!r||typeof r!=='object'||!Array.isArray(r.results)||!Number.isFinite(Date.parse(text(r.fetchedAt))))continue;
  if(!['arxiv_search','github_search_repositories','web_search'].includes(receipt.api))continue;
  for(const source of r.results){const title=text(source.title||source.name);const sourceUrl=url(source.url);if(!title||title.length>512||!sourceUrl)continue;
   const ids=[sourceUrl,text(source.id),text(source.name),...(receipt.api==='arxiv_search'?[sourceUrl.replace(/^https?:\/\/arxiv.org\/abs\//,'arXiv:')]:[])].filter(Boolean);
   if(text(item.id)&&!ids.includes(text(item.id)))continue;
   if(text(item.url)&&url(item.url)!==sourceUrl)continue;
   const match=(text(item.url)&&url(item.url)===sourceUrl)||(text(item.id)&&ids.includes(text(item.id)))||(text(item.name)&&text(item.name)===title);
   if(match)candidates.push({source,title,sourceUrl,fetchedAt:r.fetchedAt});
  }
 }
 const unique=new Map(candidates.map(c=>[c.sourceUrl,c]));if(unique.size!==1)return null;
 const c=[...unique.values()][0];const contribution=text(item.detail);if(contribution.length>2048)return null;
 // Code URLs are source evidence only, not an asserted absence on the entire web.
 const sourceBody=JSON.stringify(c.source);const codeMatches=sourceBody.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/g)||[];
 const codeUrl=[...new Set(codeMatches)][0]||null;
 const detail=[contribution,`Source: ${c.sourceUrl}`,`Retrieved: ${c.fetchedAt}`,codeUrl?`Code: ${codeUrl}`:'Code: not found in this retrieved evidence'].filter(Boolean).join('\n');
 const card={name:c.title,id:c.sourceUrl,detail,publicContribution:contribution,sourceUrl:c.sourceUrl,fetchedAt:c.fetchedAt,codeUrl,...(text(item.group)?{group:text(item.group).slice(0,24)}:{})};boundCards.add(card);return card;
}

/** lastActionPayload.toolResults is a host-owned slot, replaced unconditionally at commit.
 * Rebinding from its actual receipts survives JSON persistence; never trust a model brand. */
export function publicEvidenceFromRuntime(state:Row):Row[]{
 const results=state.lastActionPayload?.toolResults;return results&&typeof results==='object'&&!Array.isArray(results)?Object.values(results).filter((v:any)=>v&&v.ok===true&&['web-tool-dispatched-arguments','public-tool-prefetch'].includes(v.requestSource)) as Row[]:[];
}
export function publicCardFromRuntime(item:Row,state:Row){return bindPublicCard({...item,detail:typeof item.publicContribution==='string'?item.publicContribution:item.detail},publicEvidenceFromRuntime(state));}
