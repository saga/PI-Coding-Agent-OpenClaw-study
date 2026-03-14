/**
 * 测试 Chrome 内置 AI 功能
 */

import { MCPChromeDevToolsClient, ChromeAIClient } from './web-crawler.js';

async function testChromeAI() {
  console.log('🧪 Chrome 内置 AI 功能测试');
  console.log('='.repeat(60));

  const mcpClient = new MCPChromeDevToolsClient();
  const aiClient = new ChromeAIClient(mcpClient);

  try {
    // 连接到浏览器
    console.log('\n📡 步骤 1: 连接到 Chrome...');
    await mcpClient.connect('ai-test');
    console.log('✅ 已连接');

    // 检查 AI 可用性
    console.log('\n📡 步骤 2: 检查 Chrome 内置 AI 可用性...');
    const status = await aiClient.checkAvailability();
    
    console.log(`   可用性状态: ${status.availability}`);
    if (status.available) {
      console.log('   ✅ AI 可用!');
      if (status.params) {
        console.log(`   模型参数:`);
        console.log(`     - defaultTopK: ${status.params.defaultTopK}`);
        console.log(`     - maxTopK: ${status.params.maxTopK}`);
        console.log(`     - defaultTemperature: ${status.params.defaultTemperature}`);
        console.log(`     - maxTemperature: ${status.params.maxTemperature}`);
      }
    } else {
      console.log('   ❌ AI 不可用');
      if (status.error) {
        console.log(`   错误: ${status.error}`);
      }
      console.log('\n   请确保:');
      console.log('   1. 访问 chrome://flags/#optimization-guide-on-device-model 设为 Enabled');
      console.log('   2. 访问 chrome://flags/#prompt-api-for-gemini-nano 设为 Enabled');
      console.log('   3. 重启 Chrome');
      return;
    }

    // 测试基本 prompt
    console.log('\n📡 步骤 3: 测试基本 prompt...');
    const testPrompt = '请用一句话介绍你自己。';
    console.log(`   发送: "${testPrompt}"`);
    
    const response = await aiClient.prompt(testPrompt);
    console.log(`   响应: ${response}`);

    // 测试内容摘要
    console.log('\n📡 步骤 4: 测试内容摘要...');
    const testContent = `
      Fidelity International 是一家全球领先的资产管理公司，
      为个人和机构投资者提供投资解决方案。公司成立于 1969 年，
      总部位于百慕大，在全球拥有超过 4000 名员工。
      Fidelity 专注于主动投资管理，涵盖股票、债券、
      多元资产和房地产等多个资产类别。
    `;
    
    const summary = await aiClient.summarizeContent(testContent, 100);
    console.log(`   摘要: ${summary}`);

    // 测试内容分类
    console.log('\n📡 步骤 5: 测试内容分类...');
    const categories = ['财经', '科技', '体育', '娱乐'];
    const classifyResult = await aiClient.classifyContent(testContent, categories);
    console.log(`   分类结果: ${classifyResult}`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ 所有测试完成!');

  } catch (error) {
    console.error('❌ 测试失败:', error);
  } finally {
    await mcpClient.disconnect();
  }
}

testChromeAI();
