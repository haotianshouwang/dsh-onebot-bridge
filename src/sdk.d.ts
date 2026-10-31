export type QQContext = Readonly<{actor:string;bot:string;kind:'private'|'group';peer:string;key:string;plugin:string;generation:number}>;
export type QQEvent = Readonly<Record<string,unknown>>;
export type QQContextPrompt = Readonly<{actor:string;kind:'private'|'group';peer:string;key:string;text:string}>;
export interface PluginScope {allUsers?:boolean;private:boolean;users:string[];groups:string[]}
export interface ConfigField {
 type:'string'|'boolean'|'number'|'string[]';title?:string;description?:string;default?:unknown;required?:boolean;
 min?:number;max?:number;integer?:boolean;maxLength?:number;maxItems?:number;enum?:string[];multiline?:boolean;format?:'qq';
}
export interface SettingsDefinition {title:string;description?:string;sections?:{title:string;fields:string[]}[]}
export interface PageData {
 columns?:{key:string;label:string;format?:'datetime'}[];rows?:Record<string,unknown>[];
 stats?:{label:string;value:string|number}[];groups?:string[];total?:number;offset?:number;hasMore?:boolean;
}
export interface NativePackageManifest {
 id:string;name:string;version:string;description?:string;bundled?:boolean;apiVersion?:2;type?:'native-source'|'declarative'|'builtin'|'market';entry?:string;permissions?:string[];
 capabilities:('events'|'actions'|'resources'|'storage'|'automatic-replies'|'context')[];
 dependencies?:Record<string,string>;configVersion?:number;configSchema?:Record<string,ConfigField>;
 configMigrations?:{to:number;rename?:Record<string,string>;defaults?:Record<string,unknown>;remove?:string[]}[];
 settings?:SettingsDefinition;eventTimeoutMs?:number;
 automations?:{id:string;event:'group_increase'|'group_decrease'|'group_admin'|'group_ban'|'notify';title:string;configGate?:string}[];
 storagePolicy?:{collection:string;timestamp:string;group?:string;daysField:string;limitField:string};
}
export interface QQPackageSDK {
 readonly id:string;readonly apiVersion:2;
 active():boolean;getConfig():Record<string,unknown>;getScope():PluginScope;reject(message:string):never;isOwner(context:QQContext):boolean;detach(work:()=>void):void;
 on(types:('message'|'notice'|'request'|'meta')[],handler:(event:QQEvent,context:QQContext|null,signal:AbortSignal)=>void|Promise<void>):()=>void;
 action(name:string,definition:{description:string;ownerOnly?:boolean;publicSafe?:boolean;mutating?:boolean;timeoutMs?:number;parameters:{type:'object';properties:Record<string,unknown>;required?:string[];additionalProperties?:false}},handler:(args:Record<string,unknown>,context:QQContext,signal:AbortSignal)=>unknown|Promise<unknown>):()=>void;
 settings(definition:SettingsDefinition,provider?:(query:Record<string,unknown>)=>PageData|Promise<PageData>):()=>void;
 invoke(capability:string,args:Record<string,unknown>,context:QQContext,signal?:AbortSignal):Promise<unknown>;
 registerContextProvider(provider:(input:QQContextPrompt)=>string|Promise<string>):()=>void;
 putResource(bytes:Uint8Array,context:QQContext,options?:{purpose?:'image'|'audio'|'video'|'file';name?:string}):Promise<{id:string;key:string;mime:string;size:number;expires:number}>;
 automaticReply(event:QQEvent,automationId:string,text:string):Promise<unknown>;
 storage:{get():Record<string,unknown>;set(value:unknown):Promise<unknown>;update(updater:(current:Record<string,unknown>)=>unknown):Promise<unknown>};
 dispose():Promise<void>;
}
export interface QQFrameworkService {
 readonly apiVersion:2;readonly features:readonly string[];
 catalog():unknown[];registerTrustedPackage(manifest:NativePackageManifest):QQPackageSDK;
}
declare module '@deepseek-ai/cordis' {interface Context {qqFramework:QQFrameworkService}}
