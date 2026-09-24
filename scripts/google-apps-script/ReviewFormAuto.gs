var REVIEW_FORM_MANIFEST_URL = 'https://gra-commu-vocab-test-production-77e7.up.railway.app/api/review-forms/ready';
var REVIEW_FORM_TEMPLATE_SOURCE_ID = '1HluMcgJFYc6pU7x0pWbdgIwh-20qtAum6qUEDpEN6gg';
var REVIEW_FORM_TEMPLATE_PROPERTY = 'REVIEW_FORM_TEMPLATE_ID';

function buildReviewTaskFromManifest_(record) {
  var ids = Array.isArray(record && record.questionIds) ? record.questionIds.map(String) : [];
  if (ids.length !== 50 || Object.keys(ids.reduce(function(seen, id) {
    seen[id] = true;
    return seen;
  }, {})).length !== 50) throw new Error((record && record.course || '復習日') + ': 確定済み50問が不正です');

  var questionById = {};
  (TASKS || []).forEach(function(task) {
    (task.questions || []).forEach(function(question) {
      if (question && question.questionId) questionById[question.questionId] = question;
    });
  });
  var questions = ids.map(function(id) { return questionById[id]; });
  if (questions.some(function(question) { return !question; })) {
    throw new Error((record.course || '復習日') + ': サイトの確定問題がフォーム教材に見つかりません');
  }
  var category = String(record.category || '').toLowerCase();
  var courseIndexes = { clacel: 0, toeic: 1, ielts: 2 };
  if (!Object.prototype.hasOwnProperty.call(courseIndexes, category)) throw new Error('コースが不正です');
  return {
    day: Number(record.reviewDay),
    course: String(record.course || category),
    courseIndex: courseIndexes[category],
    isReview: true,
    questions: questions
  };
}

function ensureReviewFormTemplate_() {
  var properties = PropertiesService.getScriptProperties();
  var existing = properties.getProperty(REVIEW_FORM_TEMPLATE_PROPERTY);
  if (existing) return existing;
  var copy = DriveApp.getFileById(REVIEW_FORM_TEMPLATE_SOURCE_ID).makeCopy('ÖSH 復習Googleフォーム 自動生成テンプレート');
  var form = FormApp.openById(copy.getId());
  form.getItems().slice().reverse().forEach(function(item) { form.deleteItem(item); });
  form.setTitle('ÖSH 復習Googleフォーム 自動生成テンプレート');
  form.setDescription('このフォームは自動生成専用です。回答には使用しません。');
  form.setAcceptingResponses(false);
  properties.setProperty(REVIEW_FORM_TEMPLATE_PROPERTY, form.getId());
  return form.getId();
}

function createReviewFormFromTemplate_(task, taskKey, properties) {
  var total = task.questions.length;
  if (total !== 50) throw new Error(task.course + ': 50問ではありません');
  var title = task.course + ' Day' + task.day + '回答用';
  var spreadsheet = SpreadsheetApp.create(title + '｜回答・採点');
  var scoreSheet = spreadsheet.getSheets()[0].setName('採点結果');
  scoreSheet.getRange(1, 1, 1, 5).setValues([['回答日時', '名前', 'Day', '点数（50点満点）', '満点判定']]);
  scoreSheet.setFrozenRows(1);
  scoreSheet.getRange(1, 1, scoreSheet.getMaxRows(), 5).createFilter();
  scoreSheet.autoResizeColumns(1, 5);

  var templateId = ensureReviewFormTemplate_();
  var formCopy = DriveApp.getFileById(templateId).makeCopy(title);
  var form = FormApp.openById(formCopy.getId());
  form.setTitle(title);
  form.setDescription(task.course + ' Day' + task.day + 'の復習50問です。開始後12分30秒を目安に送信してください。Googleフォームでは自動提出されません。');
  form.setIsQuiz(true);
  form.setProgressBar(true);
  form.setCollectEmail(false);
  form.setShuffleQuestions(false);
  form.setShowLinkToRespondAgain(false);
  form.setPublishingSummary(false);
  form.setAcceptingResponses(true);
  form.addTextItem().setTitle('お名前').setRequired(true);
  task.questions.forEach(function(question, questionIndex) {
    var feedback = FormApp.createFeedback().setText('正解：' + question.answer).build();
    var hint = String(question.hint || question.base || question.answer).charAt(0).toLowerCase();
    form.addTextItem()
      .setTitle('Q' + (questionIndex + 1) + '. ' + question.ja + '\n頭文字ヒント：' + hint)
      .setHelpText(question.sentence + '\n' + question.sentenceJa)
      .setPoints(1)
      .setGeneralFeedback(feedback)
      .setRequired(false);
  });
  form.setConfirmationMessage('回答ありがとうございました。「スコアを表示」を押すと、点数・問題文・あなたの回答・正解を確認できます。');

  var config = {
    day: task.day,
    course: task.course,
    formId: form.getId(),
    spreadsheetId: spreadsheet.getId(),
    total: total,
    questions: task.questions
  };
  reviewApplyNativeAnswerKeys_(config);
  ScriptApp.newTrigger('gradeSubmission_').forForm(form).onFormSubmit().create();
  properties.setProperty('FORM_CONFIG_' + form.getId(), JSON.stringify(config));
  properties.setProperty(taskKey, JSON.stringify(config));
  updateManagementSheet_(task, form.getPublishedUrl(), spreadsheet.getUrl());
  Logger.log(title + ' | ' + form.getPublishedUrl() + ' | ' + spreadsheet.getUrl());
  return config;
}

function syncReadyReviewForms() {
  var response = UrlFetchApp.fetch(REVIEW_FORM_MANIFEST_URL, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error('復習問題API ' + response.getResponseCode() + ': ' + response.getContentText());
  }
  var payload = JSON.parse(response.getContentText() || '{}');
  var properties = PropertiesService.getScriptProperties();
  var created = [];
  (payload.reviewSets || []).forEach(function(record) {
    var task = buildReviewTaskFromManifest_(record);
    var taskKey = task.course.toUpperCase() + '_DAY_' + task.day;
    if (properties.getProperty(taskKey)) return;
    var config = createReviewFormFromTemplate_(task, taskKey, properties);
    created.push({ course: task.course, day: task.day, formId: config.formId, spreadsheetId: config.spreadsheetId });
  });
  Logger.log(created.length ? '復習フォーム作成: ' + JSON.stringify(created) : '新しい復習フォームはありません');
  return created;
}

function installReviewFormAutoTrigger() {
  ScriptApp.getProjectTriggers().filter(function(trigger) {
    return trigger.getHandlerFunction() === 'syncReadyReviewForms';
  }).forEach(function(trigger) { ScriptApp.deleteTrigger(trigger); });
  ScriptApp.newTrigger('syncReadyReviewForms').timeBased().everyMinutes(15).create();
  ensureReviewFormTemplate_();
  return syncReadyReviewForms();
}

function reviewApplyNativeAnswerKeys_(config) {
  var formJson = reviewFormsApiRequest_('get', 'https://forms.googleapis.com/v1/forms/' + config.formId);
  var quizItems = reviewQuizItems_(formJson);
  if (quizItems.length !== 50 || config.questions.length !== 50) throw new Error(config.course + ': 50問ではありません');
  var requests = quizItems.map(function(entry) {
    var question = config.questions[entry.number - 1];
    entry.item.questionItem.question.grading = {
      pointValue: 1,
      correctAnswers: { answers: reviewAcceptedAnswers_(question) },
      generalFeedback: { text: '正解：' + question.answer }
    };
    return { updateItem: { item: entry.item, location: { index: entry.index }, updateMask: 'questionItem.question.grading' } };
  });
  reviewFormsApiRequest_('post', 'https://forms.googleapis.com/v1/forms/' + config.formId + ':batchUpdate', { requests: requests });
}

function reviewQuizItems_(formJson) {
  return (formJson.items || []).map(function(item, index) {
    var match = String(item.title || '').match(/^Q([0-9]+)[.]/);
    return match && item.questionItem && item.questionItem.question
      ? { item: item, index: index, number: Number(match[1]) }
      : null;
  }).filter(Boolean).sort(function(left, right) { return left.number - right.number; });
}

function reviewAcceptedAnswers_(question) {
  var seen = {}, answers = [];
  [question.answer].concat(question.altAnswers || []).forEach(function(value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) return;
    [text, text.charAt(0).toUpperCase() + text.slice(1)].forEach(function(candidate) {
      if (!seen[candidate]) { seen[candidate] = true; answers.push({ value: candidate }); }
    });
  });
  return answers;
}

function reviewFormsApiRequest_(method, url, payload) {
  var options = {
    method: method,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
    contentType: 'application/json'
  };
  if (payload) options.payload = JSON.stringify(payload);
  var response = UrlFetchApp.fetch(url, options);
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Forms API ' + code + ': ' + response.getContentText());
  var text = response.getContentText();
  return text ? JSON.parse(text) : {};
}
