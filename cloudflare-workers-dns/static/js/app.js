/**
 * 六趣DNS - 前端应用主逻辑
 * 使用 Alpine.js 进行数据绑定
 */

// API 基础配置
const API_BASE = '';

// Token 管理
function getToken() {
  return localStorage.getItem('token');
}

function setToken(token) {
  localStorage.setItem('token', token);
}

function removeToken() {
  localStorage.removeItem('token');
}

// 通用 API 请求
async function apiRequest(url, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(API_BASE + url, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (data.code === 401) {
    removeToken();
    window.location.href = '/login';
    throw new Error('未登录');
  }

  if (data.code >= 400) {
    throw new Error(data.message || '请求失败');
  }

  return data;
}

// 全局认证检查
function checkAuth() {
  return {
    user: null,
    async init() {
      const token = getToken();
      if (!token) return;
      try {
        const data = await apiRequest('/api/auth/me');
        this.user = data.data;
      } catch (e) {
        removeToken();
      }
    },
    async logout() {
      removeToken();
      window.location.href = '/login';
    }
  };
}

// 域名列表
function domainList() {
  return {
    domains: [],
    async loadDomains() {
      try {
        const data = await apiRequest('/api/domains');
        this.domains = data.data || [];
      } catch (e) {
        console.error('加载域名失败:', e);
      }
    }
  };
}

// 用户域名列表
function userDomains() {
  return {
    domains: [],
    loading: true,
    async load() {
      this.loading = true;
      try {
        const data = await apiRequest('/api/user/domains');
        this.domains = data.data || [];
      } catch (e) {
        console.error('加载域名失败:', e);
      }
      this.loading = false;
    }
  };
}

// DNS 记录管理
function dnsRecords(subdomainId) {
  return {
    records: [],
    subdomain: null,
    loading: true,
    showAddForm: false,
    newRecord: { type: 'A', name: '', content: '', ttl: 300, proxied: false },
    async load() {
      this.loading = true;
      try {
        const data = await apiRequest(`/api/records/${subdomainId}`);
        this.records = data.data || [];
      } catch (e) {
        console.error('加载DNS记录失败:', e);
      }
      this.loading = false;
    },
    async addRecord() {
      try {
        await apiRequest(`/api/records/${subdomainId}`, {
          method: 'POST',
          body: JSON.stringify(this.newRecord),
        });
        this.showAddForm = false;
        this.newRecord = { type: 'A', name: '', content: '', ttl: 300, proxied: false };
        await this.load();
      } catch (e) {
        alert('添加失败: ' + e.message);
      }
    },
    async deleteRecord(recordId) {
      if (!confirm('确定删除此记录？')) return;
      try {
        await apiRequest(`/api/records/${subdomainId}/${recordId}`, { method: 'DELETE' });
        await this.load();
      } catch (e) {
        alert('删除失败: ' + e.message);
      }
    }
  };
}

// 登录
function loginForm() {
  return {
    account: '',
    password: '',
    error: '',
    loading: false,
    async submit() {
      this.error = '';
      this.loading = true;
      try {
        const data = await apiRequest('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ account: this.account, password: this.password }),
        });
        setToken(data.data.token);
        window.location.href = '/user';
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    }
  };
}

// 注册
function registerForm() {
  return {
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    error: '',
    loading: false,
    async submit() {
      this.error = '';
      if (this.password !== this.confirmPassword) {
        this.error = '两次密码不一致';
        return;
      }
      this.loading = true;
      try {
        const data = await apiRequest('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({
            username: this.username,
            email: this.email,
            password: this.password,
          }),
        });
        setToken(data.data.token);
        window.location.href = '/user';
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    }
  };
}

// 购买域名
function buyDomain() {
  return {
    plans: [],
    selectedPlan: null,
    subdomainName: '',
    couponCode: '',
    error: '',
    success: '',
    loading: false,
    async loadPlans(domainId) {
      try {
        const data = await apiRequest(`/api/plans/domain/${domainId}`);
        this.plans = data.data || [];
      } catch (e) {
        console.error('加载套餐失败:', e);
      }
    },
    async submit() {
      this.error = '';
      this.success = '';
      if (!this.selectedPlan) { this.error = '请选择套餐'; return; }
      if (!this.subdomainName) { this.error = '请输入域名前缀'; return; }

      this.loading = true;
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const domainId = urlParams.get('domain');
        const data = await apiRequest('/api/domains/buy', {
          method: 'POST',
          body: JSON.stringify({
            domain_id: parseInt(domainId),
            plan_id: this.selectedPlan,
            subdomain_name: this.subdomainName,
            coupon_code: this.couponCode || undefined,
          }),
        });
        this.success = '购买成功！';
        setTimeout(() => { window.location.href = '/user/domains'; }, 1500);
      } catch (e) {
        this.error = e.message;
      }
      this.loading = false;
    }
  };
}

// 套餐列表
function planList() {
  return {
    plans: [],
    async load() {
      try {
        const data = await apiRequest('/api/plans');
        this.plans = data.data || [];
      } catch (e) {
        console.error('加载套餐失败:', e);
      }
    }
  };
}

// 用户中心
function userCenter() {
  return {
    user: null,
    stats: { usedDomains: 0, totalOrders: 0 },
    async load() {
      try {
        const data = await apiRequest('/api/auth/me');
        this.user = data.data;
      } catch (e) {
        window.location.href = '/login';
      }
    }
  };
}