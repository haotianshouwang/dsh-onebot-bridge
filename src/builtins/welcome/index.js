export const manifest={id:'welcome',apiVersion:2,name:'入群欢迎',version:'1.0.0',events:['notice']};
export function responses(config,event){
 return event.type==='notice'&&event.name==='group_increase'&&event.kind==='group'&&config.groups.includes(event.peer)?[{id:'welcome',text:config.text}]:[];
}
