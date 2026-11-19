import {projectKnowledge} from './worldbook.js';
export async function deliverHandoff({bridge,sessions,key,session,mode}){
  const {campaignId,branchId}=sessions.current(key).binding,source=session.handoffSource;
  const messageId=session.messages.at(-1)?.id;
  const check=()=>{if(key!==bridge.key()||sessions.current(key).binding.branchId!==branchId||session.messages.at(-1)?.id!==messageId)throw new Error('聊天、回复或分支已切换，请重新预览当前回复。');};
  check();if(source&&(source.branchId!==branchId||source.messageId!==session.messages.at(-1)?.id))throw new Error('回复或分支已变化，请重新预览当前回复。');
  session.revision++;await sessions.cache(key,session);
  const branch=await sessions.db.get(campaignId,branchId);let text=session.handoff;
  if(branch.worldbook?.revision!==branch.world.revision){const knowledge=projectKnowledge(branch.world);if(knowledge.count)text+='\n\n【本局当前有效情报｜世界书待同步，以此快照为准】\n'+knowledge.content;}
  check();bridge.fill(text,mode);return{text,worldbookPending:branch.worldbook?.revision!==branch.world.revision};
}
