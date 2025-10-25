export async function getCodingGuidelines() {
  const workspaceId = process.env.WORKSPACE_ID || '';
  const docId = process.env.DOC_ID || '';
  const pageId = process.env.PAGE_ID || '';

  const url = `https://api.clickup.com/api/v3/workspaces/${workspaceId}/docs/${docId}/pages/${pageId}?content_format=text%2Fmd`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      Authorization: process.env.CLICKUP_API_KEY || '',
    }
  });

  return res.json();
}

export async function getTaskDetails() {
  const taskId = process.env.PR_BRANCH || '';
  const workspaceId = process.env.WORKSPACE_ID || '';

  const url = `https://api.clickup.com/api/v2/task/${taskId}?custom_task_ids=true&team_id=${workspaceId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      Authorization: process.env.CLICKUP_API_KEY || '',
    },
  });

  return res.json();
}