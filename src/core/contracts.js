// 能力验证契约：每种写操作「什么才算确认」。
//
// 默认契约 ack=confirmed 表示沿用现有语义：动作正常返回即视为成功。
// 写操作显式声明更弱或更强的语义：
//   ack:'submitted' 网关 ACK 只算已提交（消息、上传、资料修改）
//   ack:'accepted'  下游只确认受理，没有回读（QQ 空间评论）
//   verify:'readback' 必须回读并匹配才算 confirmed（昵称）
//
// 注意：契约只影响新增的 state，不改变 outcome，避免破坏现有调用方与 UI。
const messageId = raw => ({
  messageId: raw?.data?.message_id != null ? String(raw.data.message_id) : null
});

const send = Object.freeze({
  ack: 'submitted',
  messageReceipt: true,
  evidence: raw => ({...messageId(raw), messageStored: raw?.messageStored === true})
});
const write = Object.freeze({ack: 'submitted'});

export const DEFAULT_CONTRACT = Object.freeze({ack: 'confirmed'});

export const CAPABILITY_CONTRACTS = Object.freeze({
  // 消息：网关返回 message_id 也只证明「已提交」，送达与展示由 QQ 决定。
  'qq.message.send': send,
  'qq.image.send': send,
  'qq.audio.send': send,
  'qq.video.send': send,
  'qq.file.send': send,
  'qq.forward.send': send,
  'qq.message.recall': write,
  'qq.message.react': write,

  // 资料：昵称是唯一已实现回读的写操作；其余仍是 ACK。
  'qq.profile.nickname': Object.freeze({
    ack: 'submitted',
    verify: 'readback',
    readback: raw => raw?.visible === true,
    evidence: raw => ({visible: raw?.visible === true})
  }),
  'qq.profile.avatar': write,
  'qq.group.selfCard': write,
  'qq.group.name': write,
  'qq.request.decide': write,
  'qq.poke': write,

  // 任务动作只修改本地持久化状态；未知步骤恢复必须走显式 recover。
  'qq.task.create': Object.freeze({ack: 'confirmed'}),
  'qq.task.plan': Object.freeze({ack: 'confirmed'}),
  'qq.task.transition': Object.freeze({ack: 'confirmed'}),
  'qq.task.recover': Object.freeze({ack: 'confirmed'}),
  'qq.task.step': Object.freeze({ack: 'confirmed'}),
  'qq.task.verify': Object.freeze({ack: 'confirmed'}),
  'qq.task.attach-memory': Object.freeze({ack: 'confirmed'}),

  // 原生包：本地落库算确认，远端写操作降级。
  'plugin.qq-sticker.send': send,
  'plugin.qq-sticker.save': Object.freeze({ack: 'confirmed'}),
  'plugin.qq-sticker.steal': Object.freeze({ack: 'confirmed'}),
  'plugin.qq-sticker.annotate': Object.freeze({ack: 'confirmed'}),
  'plugin.qq-sticker.remove': Object.freeze({ack: 'confirmed'}),
  'plugin.qq-tts.speak': send,
  'plugin.qq-web.image-send': send,
  'plugin.qq-qzone.publish': Object.freeze({ack: 'submitted', evidence: raw => ({postId: raw?.id ? String(raw.id) : null})}),
  'plugin.qq-qzone.comment': Object.freeze({ack: 'accepted'}),
  'plugin.qq-memory.remember': Object.freeze({ack: 'confirmed', evidence: raw => ({id: raw?.id || raw?.memoryId || null})}),
  'plugin.qq-memory.forget': Object.freeze({ack: 'confirmed'}),
  'plugin.qq-autonomy.diary-write': Object.freeze({ack: 'confirmed'}),
  'plugin.qq-autonomy.run': Object.freeze({ack: 'accepted'})
});

// OneBot 线缆动作的契约：用于 Actions.request 在拿到网关响应时先归类，
// 再交给能力契约做回读升级。查询动作返回 null，表示沿用默认 confirmed。
export const WIRE_ACTION_CONTRACTS = Object.freeze({
  send_group_msg: send,
  send_private_msg: send,
  send_group_forward_msg: send,
  send_private_forward_msg: send,
  upload_group_file: write,
  upload_private_file: write,
  set_qq_avatar: write,
  set_qq_profile: write,
  set_group_card: write,
  set_group_name: write,
  set_friend_add_request: write,
  set_group_add_request: write,
  delete_msg: write,
  set_msg_emoji_like: write,
  group_poke: write,
  friend_poke: write,
  send_qzone_msg: write
});

export function wireContract(action) {
  return WIRE_ACTION_CONTRACTS[String(action || '')] || null;
}

export function contractFor(capability) {
  return CAPABILITY_CONTRACTS[String(capability || '')] || DEFAULT_CONTRACT;
}

// 供管理台/工具结果展示：明确写出该能力的确认条件。
export function contractInfo(capability) {
  const contract = contractFor(capability);
  return {
    capability: String(capability || ''),
    ack: contract.ack || 'confirmed',
    verify: contract.verify || 'ack',
    describes: contract.verify === 'readback' ? '必须回读匹配' : contract.ack === 'accepted' ? '下游仅受理' : contract.ack === 'submitted' ? '网关已提交' : '动作正常返回'
  };
}
