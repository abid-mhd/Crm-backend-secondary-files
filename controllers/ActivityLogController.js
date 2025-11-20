const db = require('../config/db');

class ActivityLogController {
  // Log activity function
  async logActivity(activityData) {
    try {
      const { employee_id, action, description, module, record_id = null } = activityData;
      
      const query = `
        INSERT INTO activity_logs (employee_id, action, description, module, record_id)
        VALUES (?, ?, ?, ?, ?)
      `;
      
      await db.execute(query, [
        employee_id,
        action,
        description,
        module,
        record_id
      ]);
      
      return true;
    } catch (error) {
      console.error('Error logging activity:', error);
      return false;
    }
  }

  // Get activity logs
  async getActivityLogs(req, res) {
    try {
      const { page = 1, limit = 20, module, employee_id, start_date, end_date } = req.query;
      const offset = (page - 1) * limit;

      let query = `
        SELECT 
          al.*,
          e.name as employee_name,
          e.employee_no
        FROM activity_logs al
        LEFT JOIN employees e ON al.employee_id = e.id
      `;

      let countQuery = `SELECT COUNT(*) as total FROM activity_logs al`;
      let whereConditions = [];
      const queryParams = [];

      if (module) {
        whereConditions.push('al.module = ?');
        queryParams.push(module);
      }

      if (employee_id) {
        whereConditions.push('al.employee_id = ?');
        queryParams.push(employee_id);
      }

      if (start_date) {
        whereConditions.push('DATE(al.created_at) >= ?');
        queryParams.push(start_date);
      }

      if (end_date) {
        whereConditions.push('DATE(al.created_at) <= ?');
        queryParams.push(end_date);
      }

      if (whereConditions.length > 0) {
        const whereClause = ' WHERE ' + whereConditions.join(' AND ');
        query += whereClause;
        countQuery += whereClause;
      }

      query += ` ORDER BY al.created_at DESC LIMIT ? OFFSET ?`;
      
      const [activities] = await db.execute(query, [...queryParams, parseInt(limit), parseInt(offset)]);
      const [countResult] = await db.execute(countQuery, queryParams);
      const total = countResult[0].total;

      res.json({
        success: true,
        activities,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Error fetching activity logs:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to fetch activity logs',
        error: error.message
      });
    }
  }
}

module.exports = new ActivityLogController();