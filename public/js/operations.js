let operationsAreaRecords = [];

function operationsHeaders(json = true) {
  const token = getMessagingToken();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function operationsRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { ...operationsHeaders(), ...(options.headers || {}) } });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(result?.message || 'The operation could not be completed.');
  return result;
}

function operationsMessage(message, error = false) {
  const box = document.getElementById('operationsMessage');
  if (!box) return;
  box.textContent = message;
  box.classList.remove('hidden', 'border-rose-700', 'text-rose-200', 'border-emerald-700', 'text-emerald-200');
  box.classList.add(error ? 'border-rose-700' : 'border-emerald-700', error ? 'text-rose-200' : 'text-emerald-200');
  window.setTimeout(() => box.classList.add('hidden'), 5000);
}

function populateOperationsAreaSelectors(areas) {
  operationsAreaRecords = areas;
  for (const selectorId of ['subscriptionAreaSelect', 'taskAreaSelect', 'alertBroadcastAreaSelect']) {
    const selector = document.getElementById(selectorId);
    if (!selector) continue;
    const previous = selector.value;
    selector.innerHTML = `<option value="">${selectorId === 'taskAreaSelect' ? 'Select task area' : 'Select district or upazila'}</option>`;
    for (const area of areas) {
      const option = document.createElement('option');
      option.value = area.id;
      option.textContent = area.tier === 'UPAZILA' && area.parentName
        ? `${area.name} Upazila, ${area.parentName} District`
        : `${area.name} District`;
      selector.appendChild(option);
    }
    if (previous) selector.value = previous;
  }
}

async function loadOperationsDashboard() {
  const section = document.getElementById('operationsSection');
  if (!section || !currentUser?.id) {
    section?.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  const isResponder = ['WORKER', 'COORDINATOR', 'ADMIN'].includes(currentUser.role);
  const canManage = ['COORDINATOR', 'ADMIN'].includes(currentUser.role);
  document.getElementById('alertBroadcastPanel').classList.toggle('hidden', !canManage);
  document.getElementById('responseTaskPanel').classList.toggle('hidden', !isResponder);
  document.getElementById('responseTaskForm').classList.toggle('hidden', !canManage);
  document.getElementById('shelterOperationsPanel').classList.toggle('hidden', !canManage);
  document.getElementById('volunteerRosterPanel').classList.toggle('hidden', !canManage);
  document.getElementById('auditPanel').classList.toggle('hidden', !canManage);

  try {
    const [locationResponse, subscriptions, notifications, profile] = await Promise.all([
      fetch('/api/locations'),
      operationsRequest('/api/operations/alert-subscriptions'),
      operationsRequest('/api/operations/notifications'),
      operationsRequest('/api/operations/volunteers/me')
    ]);
    if (!locationResponse.ok) throw new Error('Unable to load areas for operations.');
    const locationData = await locationResponse.json();
    const areas = [
      ...(locationData.districts || []).map(area => ({ ...area, tier: 'DISTRICT' })),
      ...(locationData.upazilas || []).map(area => ({ ...area, tier: 'UPAZILA' }))
    ].sort((a, b) => a.name.localeCompare(b.name));
    populateOperationsAreaSelectors(areas);
    if (currentUser.role === 'ADMIN') {
      const nationwide = document.createElement('option');
      nationwide.value = 'NATIONWIDE';
      nationwide.textContent = 'Nationwide (administrator only)';
      document.getElementById('alertBroadcastAreaSelect').appendChild(nationwide);
    }

    const form = document.getElementById('volunteerProfileForm');
    form.elements.skills.value = (profile?.skills || []).join(', ');
    form.elements.availabilityNote.value = profile?.availabilityNote || '';
    form.elements.isAvailable.checked = profile?.isAvailable === true;
    document.getElementById('alertSubscriptionList').innerHTML = subscriptions.length
      ? subscriptions.map(item => `<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 p-2">
          <span>${escapeHtml(item.administrativeNode.name)} · ${escapeHtml(item.minimumSeverity)} · ${escapeHtml(item.hazardTypes.join(', ') || 'All hazards')}</span>
          <button type="button" onclick="removeAlertSubscription('${escapeHtml(item.id)}')" class="text-rose-300 hover:text-rose-200">Remove</button></div>`).join('')
      : '<p>No alert subscriptions yet.</p>';
    const unread = notifications.filter(item => !item.readAt).length;
    document.getElementById('notificationCount').textContent = `${unread} unread`;
    document.getElementById('operationsNotifications').innerHTML = notifications.length
      ? notifications.map(item => `<article class="rounded-lg border ${item.readAt ? 'border-slate-800' : 'border-emerald-800'} p-2">
          <div class="flex justify-between gap-2"><strong class="text-xs text-white">${escapeHtml(item.title)}</strong>
          ${item.readAt ? '' : `<button type="button" onclick="markOperationsNotificationRead('${escapeHtml(item.id)}')" class="text-[10px] text-emerald-300">Mark read</button>`}</div>
          <p class="mt-1 text-xs text-slate-300">${escapeHtml(item.body)}</p>
          <time class="mt-1 block text-[10px] text-slate-500">${new Date(item.createdAt).toLocaleString()}</time></article>`).join('')
      : '<p class="text-xs text-slate-400">No notifications.</p>';

    if (isResponder) await loadResponseTasks();
    if (canManage) {
      await Promise.all([loadVolunteerRoster(), loadShelterOperations(), loadOperationsAudit()]);
    }
  } catch (error) {
    operationsMessage(error.message || 'Unable to load operations.', true);
  }
}

async function saveVolunteerProfile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await operationsRequest('/api/operations/volunteers/me', {
      method: 'PUT',
      body: JSON.stringify({
        skills: form.elements.skills.value.split(',').map(value => value.trim()).filter(Boolean),
        availabilityNote: form.elements.availabilityNote.value,
        isAvailable: form.elements.isAvailable.checked
      })
    });
    operationsMessage('Volunteer profile saved.');
    if (['COORDINATOR', 'ADMIN'].includes(currentUser?.role)) await loadVolunteerRoster();
  } catch (error) { operationsMessage(error.message, true); }
}

async function saveAlertSubscription(event) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await operationsRequest('/api/operations/alert-subscriptions', {
      method: 'PUT',
      body: JSON.stringify({
        administrativeNodeId: form.elements.administrativeNodeId.value,
        minimumSeverity: form.elements.minimumSeverity.value,
        hazardTypes: form.elements.hazardTypes.value.split(',').map(value => value.trim()).filter(Boolean)
      })
    });
    operationsMessage('Alert subscription saved.');
    await loadOperationsDashboard();
  } catch (error) { operationsMessage(error.message, true); }
}

async function broadcastOperationsAlert(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const areaId = form.elements.areaId.value;
  const district = areaId === 'NATIONWIDE'
    ? 'NATIONWIDE'
    : operationsAreaRecords.find(area => area.id === areaId)?.name;
  if (!district) {
    operationsMessage('Select a configured alert area.', true);
    return;
  }
  try {
    await operationsRequest('/api/alerts/broadcast', {
      method: 'POST',
      body: JSON.stringify({
        title: form.elements.title.value,
        description: form.elements.description.value,
        district,
        administrativeNodeId: areaId === 'NATIONWIDE' ? undefined : areaId,
        severity: form.elements.severity.value,
        hazardType: form.elements.hazardType.value
      })
    });
    form.reset();
    operationsMessage('Alert broadcast created. Matching users will see it in their in-app notifications.');
    await loadOperationsDashboard();
  } catch (error) { operationsMessage(error.message, true); }
}

async function removeAlertSubscription(id) {
  try {
    await operationsRequest(`/api/operations/alert-subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadOperationsDashboard();
  } catch (error) { operationsMessage(error.message, true); }
}

async function markOperationsNotificationRead(id) {
  try {
    await operationsRequest(`/api/operations/notifications/${encodeURIComponent(id)}/read`, {
      method: 'PATCH',
      body: '{}'
    });
    await loadOperationsDashboard();
  } catch (error) { operationsMessage(error.message, true); }
}

async function createResponseTask(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const assigneeIds = [...document.querySelectorAll('#taskAssigneeChoices input:checked')].map(input => input.value);
  try {
    await operationsRequest('/api/operations/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: form.elements.title.value,
        description: form.elements.description.value,
        administrativeNodeId: form.elements.administrativeNodeId.value,
        priority: form.elements.priority.value,
        dueAt: form.elements.dueAt.value || undefined,
        assigneeIds
      })
    });
    form.reset();
    operationsMessage('Response task created and assigned.');
    await loadOperationsDashboard();
  } catch (error) { operationsMessage(error.message, true); }
}

async function loadResponseTasks() {
  const container = document.getElementById('responseTaskList');
  const result = await operationsRequest('/api/operations/tasks?pageSize=50');
  container.innerHTML = result.items.length ? result.items.map(task => {
    const assignees = task.assignees.map(entry => entry.user?.fullName).filter(Boolean).join(', ');
    const canUpdate = currentUser?.role === 'COORDINATOR' || currentUser?.role === 'ADMIN' ||
      task.assignees.some(entry => entry.userId === currentUser?.id);
    const transitions = {
      OPEN: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
      ASSIGNED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
      IN_PROGRESS: ['BLOCKED', 'COMPLETED', 'CANCELLED'],
      BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: ['OPEN']
    };
    const validStatuses = transitions[task.status] || [];
    const statuses = currentUser?.role === 'WORKER'
      ? validStatuses.filter(status => ['IN_PROGRESS', 'BLOCKED', 'COMPLETED'].includes(status))
      : validStatuses;
    return `<article class="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
      <div class="flex flex-wrap justify-between gap-2"><strong class="text-sm">${escapeHtml(task.title)}</strong>
      <span class="rounded border border-slate-700 px-2 py-0.5 text-[10px]">${escapeHtml(task.status)} · ${escapeHtml(task.priority)}</span></div>
      <p class="mt-1 text-xs text-slate-300">${escapeHtml(task.description)}</p>
      <p class="mt-1 text-[10px] text-slate-400">${escapeHtml(task.administrativeNode?.name || '')}${assignees ? ` · ${escapeHtml(assignees)}` : ' · Unassigned'}</p>
      ${task.updates?.length ? `<ul class="mt-2 space-y-1 text-[10px] text-slate-400">${task.updates.slice(-3).map(update => `<li>${escapeHtml(update.status)}: ${escapeHtml(update.note)} · ${escapeHtml(update.author?.fullName || '')}</li>`).join('')}</ul>` : ''}
      ${canUpdate && statuses.length ? `<form class="mt-2 flex flex-wrap gap-2" onsubmit="updateResponseTask(event, '${escapeHtml(task.id)}')">
        <select name="status" class="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white">${statuses.map(status => `<option value="${status}" ${status === task.status ? 'selected' : ''}>${status}</option>`).join('')}</select>
        <input name="note" maxlength="2000" placeholder="Progress or completion note" class="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white">
        <button class="rounded bg-indigo-700 px-2 py-1 text-xs text-white">Update</button></form>` : ''}</article>`;
  }).join('') : '<p class="text-xs text-slate-400">No tasks in your assignment view.</p>';
}

async function updateResponseTask(event, taskId) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await operationsRequest(`/api/operations/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: form.elements.status.value, note: form.elements.note.value })
    });
    operationsMessage('Task update saved.');
    await loadOperationsDashboard();
  } catch (error) { operationsMessage(error.message, true); }
}

async function loadVolunteerRoster() {
  const volunteers = await operationsRequest('/api/operations/volunteers');
  document.getElementById('volunteerRosterList').innerHTML = volunteers.length ? volunteers.map(volunteer =>
    `<article class="rounded-lg border border-slate-800 p-2 text-xs"><strong>${escapeHtml(volunteer.user.fullName)}</strong>
      <span class="${volunteer.isAvailable ? 'text-emerald-300' : 'text-slate-400'}">${volunteer.isAvailable ? ' · Available' : ' · Unavailable'}</span>
      <p class="mt-1 text-slate-300">${escapeHtml(volunteer.skills.join(', ') || 'No skills listed')}</p>
      <p class="text-slate-500">${escapeHtml(volunteer.availabilityNote || '')}</p></article>`
  ).join('') : '<p class="text-xs text-slate-400">No volunteer profiles in your area.</p>';
  const available = volunteers.filter(item => item.isAvailable && item.user.role === 'WORKER');
  document.getElementById('taskAssigneeChoices').innerHTML = available.length
    ? available.map(item => `<label class="mr-3 inline-flex items-center gap-1 py-1"><input type="checkbox" value="${escapeHtml(item.userId)}"> ${escapeHtml(item.user.fullName)} · ${escapeHtml(item.skills.join(', ') || 'Field responder')}</label>`).join('')
    : 'No available field responders are listed in your area.';
}

async function loadShelterOperations() {
  const shelters = await operationsRequest('/api/operations/shelters');
  document.getElementById('shelterOperationsList').innerHTML = shelters.length ? shelters.map(shelter =>
    `<form class="rounded-lg border border-slate-800 p-2" onsubmit="updateShelterOperations(event, '${escapeHtml(shelter.id)}')">
      <strong class="text-xs">${escapeHtml(shelter.name)}</strong><span class="ml-2 text-[10px] text-slate-400">${escapeHtml(shelter.districtNode?.name || '')}</span>
      <p class="mt-1 text-[10px] text-slate-400">Current occupancy ${shelter.occupancy} / ${shelter.capacity} · ${escapeHtml(shelter.verificationStatus)}</p>
      <div class="mt-2 flex flex-wrap gap-2"><input name="occupancy" type="number" min="0" max="${shelter.capacity}" value="${shelter.occupancy}" aria-label="Occupancy" class="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white">
      <select name="verificationStatus" class="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white">${['UNVERIFIED', 'VERIFIED', 'NEEDS_REVIEW'].map(status => `<option ${status === shelter.verificationStatus ? 'selected' : ''}>${status}</option>`).join('')}</select>
      <input name="note" maxlength="500" placeholder="Occupancy note" class="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white">
      <button class="rounded bg-emerald-800 px-2 py-1 text-xs text-white">Save shelter status</button></div></form>`
  ).join('') : '<p class="text-xs text-slate-400">No shelters in your authorized area.</p>';
}

async function updateShelterOperations(event, shelterId) {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await operationsRequest(`/api/operations/shelters/${encodeURIComponent(shelterId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        occupancy: Number(form.elements.occupancy.value),
        verificationStatus: form.elements.verificationStatus.value,
        note: form.elements.note.value
      })
    });
    operationsMessage('Shelter update saved.');
    await loadShelterOperations();
  } catch (error) { operationsMessage(error.message, true); }
}

async function loadOperationsAudit() {
  const result = await operationsRequest('/api/operations/audit?pageSize=50');
  document.getElementById('operationsAuditList').innerHTML = result.items.length ? result.items.map(entry =>
    `<article class="rounded border border-slate-800 p-2 text-[10px] text-slate-300">
      <strong>${escapeHtml(entry.action)}</strong> · ${escapeHtml(entry.entityType)} · ${escapeHtml(entry.administrativeNode?.name || 'National')}
      · ${escapeHtml(entry.actor?.fullName || 'Former user')} · ${new Date(entry.createdAt).toLocaleString()}</article>`
  ).join('') : '<p class="text-xs text-slate-400">No operational changes recorded yet.</p>';
}

async function uploadIncidentEvidence(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.elements.file.files[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    operationsMessage('Evidence files must be 5 MB or smaller.', true);
    return;
  }
  try {
    const contentBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Unable to read the selected evidence file.'));
      reader.readAsDataURL(file);
    });
    await operationsRequest(`/api/operations/incidents/${encodeURIComponent(form.dataset.incidentId)}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, contentType: file.type, contentBase64 })
    });
    form.reset();
    operationsMessage('Incident evidence uploaded securely.');
    await loadIncidentEvidenceFor(form.dataset.incidentId);
  } catch (error) { operationsMessage(error.message, true); }
}

async function loadIncidentEvidenceFor(incidentId) {
  const container = document.getElementById(`incidentEvidence-${incidentId}`);
  if (!container) return;
  try {
    const files = await operationsRequest(`/api/operations/incidents/${encodeURIComponent(incidentId)}/attachments`);
    container.innerHTML = files.length
      ? files.map(file => `<button type="button" onclick="downloadIncidentEvidence('${escapeHtml(file.id)}')" class="mr-3 inline-flex items-center gap-1 text-emerald-300 hover:text-emerald-200">${escapeHtml(file.fileName)} (${Math.ceil(file.fileSize / 1024)} KB)</button>`).join('')
      : '<span>No evidence attached.</span>';
  } catch (error) { container.textContent = error.message || 'Unable to load evidence.'; }
}

async function downloadIncidentEvidence(attachmentId) {
  try {
    const response = await fetch(`/api/operations/attachments/${encodeURIComponent(attachmentId)}`, {
      headers: operationsHeaders(false)
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null);
      throw new Error(result?.message || 'Unable to download incident evidence.');
    }
    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const extension = contentType === 'application/pdf' ? 'pdf'
      : contentType === 'image/png' ? 'png'
        : contentType === 'image/webp' ? 'webp'
          : contentType === 'image/jpeg' ? 'jpg' : 'bin';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `incident-evidence-${attachmentId}.${extension}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { operationsMessage(error.message || 'Unable to download incident evidence.', true); }
}
