// 普通 QQ face 编号；与已安装 NapCat 的 QSid 元数据一致。
// 只列常用项供自主选择，接收时保留所有合法编号，不猜未知表情含义。
export const QQ_FACES = Object.freeze([
  {id:'0', name:'惊讶'}, {id:'3', name:'发呆'}, {id:'4', name:'得意'},
  {id:'5', name:'流泪'}, {id:'6', name:'害羞'}, {id:'9', name:'大哭'},
  {id:'10', name:'尴尬'}, {id:'11', name:'发怒'}, {id:'12', name:'调皮'},
  {id:'13', name:'呲牙'}, {id:'14', name:'微笑'}, {id:'15', name:'难过'}
]);

export function faceText(value) {
  const id = String(value ?? '');
  if (!/^\d{1,4}$/.test(id)) return '[QQ 表情]';
  const name = QQ_FACES.find(face => face.id === id)?.name;
  return '[QQ 表情 id=' + id + (name ? ' ' + name : '') + ']';
}
